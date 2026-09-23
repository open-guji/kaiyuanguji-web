/**
 * @jest-environment node
 *
 * 邀请闭环的安全回归闸（#24 审阅查出、已修的三处，外加鉴权闸与过期）。
 *
 *  1) join 不得覆盖已有成员：不绑邮箱的码 + 自填他人邮箱 = 冒充并降级（曾实测复现）
 *     且被拒时邀请码不能被白白消耗
 *  2) 不绑邮箱的 admin 邀请不得签发
 *  3) 鉴权数据只认 AUTH_KV；只绑了 ERROR_KV / FEEDBACK_KV 一律 503，不许回落
 *  4) 删人：KV 没有 delete 时走墓碑，被删的人 /me 必须 401（曾返回 500 / 仍算登录）；
 *     被删的人可重新受邀
 *  5) 鉴权闸：无 token 401、非管理员 cookie 不能发邀请；过期码 410
 */

type Store = Map<string, string>;

function makeKv(store: Store, withDelete = true) {
    const kv: Record<string, unknown> = {
        async get(k: string, t?: string) {
            const v = store.get(k);
            if (v === undefined) return null;
            return t === 'json' ? JSON.parse(v) : v;
        },
        async put(k: string, v: string) {
            store.set(k, v);
        },
    };
    if (withDelete) kv.delete = async (k: string) => { store.delete(k); };
    return kv;
}

const SECRET = 'test-jwt-secret';
const ADMIN = 'test-admin-token';
const A = { 'Content-Type': 'application/json', Authorization: `Bearer ${ADMIN}` };

function post(url: string, body: unknown, headers: Record<string, string> = { 'Content-Type': 'application/json' }) {
    return new Request(`https://x${url}`, { method: 'POST', headers, body: JSON.stringify(body) });
}
async function json(res: Response) {
    return JSON.parse(await res.text());
}
function sessionOf(res: Response) {
    return (res.headers.get('set-cookie') || '').split(';')[0];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let invite: any, join: any, me: any, revoke: any, inviteInfo: any;
beforeAll(async () => {
    invite = await import('../../../../edge-functions/api/auth/invite.js');
    inviteInfo = await import('../../../../edge-functions/api/auth/invite-info.js');
    join = await import('../../../../edge-functions/api/auth/join.js');
    me = await import('../../../../edge-functions/api/auth/me.js');
    revoke = await import('../../../../edge-functions/api/auth/revoke.js');
});

function setup(withDelete = true) {
    const store: Store = new Map();
    const env = { AUTH_KV: makeKv(store, withDelete), AUTH_JWT_SECRET: SECRET, AUTH_ADMIN_TOKEN: ADMIN };
    return { store, env };
}
async function newCode(env: unknown, body: unknown) {
    const res = await invite.onRequestPost({ env, request: post('/api/auth/invite', body, A) });
    expect(res.status).toBe(200);
    return (await json(res)).code as string;
}

describe('join 不得覆盖已有成员', () => {
    it('不绑邮箱的码自填管理员邮箱 → 409，管理员记录不变，码未被消耗', async () => {
        const { store, env } = setup();
        const boss = JSON.stringify({ role: 'admin', joinedAt: 1 });
        store.set('member:boss@x.com', boss);
        const code = await newCode(env, { role: 'reader' });

        const res = await join.onRequestPost({ env, request: post('/api/auth/join', { code, email: 'Boss@x.com ' }) });
        expect(res.status).toBe(409);
        expect(res.headers.get('set-cookie')).toBeNull();
        expect(store.get('member:boss@x.com')).toBe(boss);

        const info = await json(await inviteInfo.onRequestGet({ env, request: new Request(`https://x/api/auth/invite-info?c=${code}`) }));
        expect(info.valid).toBe(true);
    });
});

describe('invite 签发限制与鉴权闸', () => {
    it('不绑邮箱的 admin 邀请 → 400', async () => {
        const { env } = setup();
        const res = await invite.onRequestPost({ env, request: post('/api/auth/invite', { role: 'admin' }, A) });
        expect(res.status).toBe(400);
    });

    it('无 token → 401；非管理员 cookie 不能发邀请', async () => {
        const { env } = setup();
        expect((await invite.onRequestPost({ env, request: post('/api/auth/invite', { role: 'reader' }) })).status).toBe(401);

        const code = await newCode(env, { role: 'editor', email: 'ed@x.com' });
        const cookie = sessionOf(await join.onRequestPost({ env, request: post('/api/auth/join', { code }) }));
        const res = await invite.onRequestPost({
            env,
            request: post('/api/auth/invite', { role: 'admin', email: 'evil@x.com' }, { 'Content-Type': 'application/json', cookie }),
        });
        expect(res.status).toBe(401);
    });

    it('过期的码 join → 410', async () => {
        const { store, env } = setup();
        const code = await newCode(env, { role: 'reader', email: 'late@x.com' });
        const [k, v] = [...store.entries()].find(([key]) => key.startsWith('invite:'))!;
        store.set(k, JSON.stringify({ ...JSON.parse(v), expires: Math.floor(Date.now() / 1000) - 1 }));
        expect((await join.onRequestPost({ env, request: post('/api/auth/join', { code }) })).status).toBe(410);
    });
});

describe('鉴权数据只认 AUTH_KV', () => {
    it.each([['ERROR_KV'], ['FEEDBACK_KV']])('只绑 %s 时各端点 503，且不写入', async (name) => {
        const store: Store = new Map();
        const env = { [name]: makeKv(store), AUTH_JWT_SECRET: SECRET, AUTH_ADMIN_TOKEN: ADMIN };
        expect((await invite.onRequestPost({ env, request: post('/api/auth/invite', { role: 'reader' }, A) })).status).toBe(503);
        expect((await join.onRequestPost({ env, request: post('/api/auth/join', { code: 'x' }) })).status).toBe(503);
        expect((await revoke.onRequestPost({ env, request: post('/api/auth/revoke', { email: 'a@x.com', role: 'reader' }, A) })).status).toBe(503);
        expect(store.size).toBe(0);
    });
});

describe('删人立即生效', () => {
    it.each([[true], [false]])('KV delete=%s：被删的人 /me → 401，且可重新受邀', async (withDelete) => {
        const { env } = setup(withDelete as boolean);
        const code = await newCode(env, { role: 'editor', email: 'u@x.com' });
        const cookie = sessionOf(await join.onRequestPost({ env, request: post('/api/auth/join', { code }) }));
        expect((await me.onRequestGet({ env, request: new Request('https://x/api/auth/me', { headers: { cookie } }) })).status).toBe(200);

        expect((await revoke.onRequestPost({ env, request: post('/api/auth/revoke', { email: 'u@x.com' }, A) })).status).toBe(200);
        expect((await me.onRequestGet({ env, request: new Request('https://x/api/auth/me', { headers: { cookie } }) })).status).toBe(401);

        const again = await newCode(env, { role: 'reader', email: 'u@x.com' });
        expect((await join.onRequestPost({ env, request: post('/api/auth/join', { code: again }) })).status).toBe(200);
    });
});
