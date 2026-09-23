/**
 * @jest-environment node
 *
 * 双轨鉴权（#26）：feedback 的 update、track-error 的 GET / update
 * 既认共享 token，也认成员 cookie（reviewer / editor / admin）。
 *
 * 盯的几件：
 *  1) reviewer/editor/admin 的 cookie 能过，reader 的不能过
 *  2) 墓碑成员、篡改签名、过期的 cookie 一律不能过
 *  3) 成员表只认 AUTH_KV：只绑了 ERROR_KV/FEEDBACK_KV 时 cookie 这一路不过（#24 修过、#26 曾回退）
 *  4) 什么都不带仍是原来的 401/503；共享 token 那一路不受影响
 *  5) ?debug=eo 只给共享 token 或 admin
 */
import { createHmac } from 'crypto';

const SECRET = 'test-jwt-secret';
const VIEW = 'view-token';
const FB_ADMIN = 'fb-admin-token';

function b64url(buf: Buffer) {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function sign(payload: Record<string, unknown>, secret = SECRET) {
    const h = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
    const p = b64url(Buffer.from(JSON.stringify(payload)));
    const s = b64url(createHmac('sha256', secret).update(`${h}.${p}`).digest());
    return `${h}.${p}.${s}`;
}
const now = () => Math.floor(Date.now() / 1000);
const cookieFor = (sub: string, exp = now() + 3600) => `session=${sign({ sub, iat: now(), exp })}`;

function makeKv(seed: Record<string, unknown> = {}) {
    const store = new Map<string, string>(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
    return {
        store,
        async get(k: string, t?: string) {
            const v = store.get(k);
            if (v === undefined) return null;
            return t === 'json' ? JSON.parse(v) : v;
        },
        async put(k: string, v: string) { store.set(k, v); },
        async list(opts: { prefix?: string; limit?: number } = {}) {
            const keys = [...store.keys()].filter((k) => !opts.prefix || k.startsWith(opts.prefix)).map((key) => ({ key }));
            return { keys, complete: true, cursor: '' };
        },
    };
}

const MEMBERS = {
    'member:rev@x.com': { role: 'reviewer' },
    'member:ed@x.com': { role: 'editor' },
    'member:adm@x.com': { role: 'admin' },
    'member:rd@x.com': { role: 'reader' },
    'member:gone@x.com': { _deleted: true },
};

/* eslint-disable @typescript-eslint/no-explicit-any */
let te: any, fb: any;
beforeAll(async () => {
    te = await import('../../../../edge-functions/api/track-error.js');
    fb = await import('../../../../edge-functions/api/feedback.js');
});

function envs() {
    const authKv = makeKv(MEMBERS);
    const errKv = makeKv({ err_1_a: { id: 'err_1_a', kind: 'js', message: 'x', state: 'open', createdAt: '2026-09-01T00:00:00Z' } });
    const fbKv = makeKv({ fb_1_a: { id: 'fb_1_a', status: 'pending', reply: '' } });
    return {
        full: { AUTH_KV: authKv, ERROR_KV: errKv, FEEDBACK_KV: fbKv, AUTH_JWT_SECRET: SECRET, ERROR_VIEW_TOKEN: VIEW, FEEDBACK_ADMIN_TOKEN: FB_ADMIN },
        // 没绑 AUTH_KV：成员记录被故意放进了 ERROR_KV / FEEDBACK_KV，也不许被认
        noAuthKv: {
            ERROR_KV: makeKv({ ...MEMBERS, err_1_a: { id: 'err_1_a', message: 'x' } }),
            FEEDBACK_KV: makeKv({ ...MEMBERS, fb_1_a: { id: 'fb_1_a', status: 'pending' } }),
            AUTH_JWT_SECRET: SECRET, ERROR_VIEW_TOKEN: VIEW, FEEDBACK_ADMIN_TOKEN: FB_ADMIN,
        },
    };
}

const teGet = (env: unknown, cookie?: string, qs = '') =>
    te.onRequestGet({ env, request: new Request(`https://x/api/track-error?limit=10${qs}`, { headers: cookie ? { cookie } : {} }) });
const tePost = (env: unknown, body: unknown, cookie?: string) =>
    te.onRequestPost({ env, request: new Request('https://x/api/track-error', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) }) });
const fbPost = (env: unknown, body: unknown, cookie?: string) =>
    fb.onRequestPost({ env, request: new Request('https://x/api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) }) });

describe('成员 cookie 按角色放行', () => {
    it.each(['rev@x.com', 'ed@x.com', 'adm@x.com'])('%s 能读错误、能标 resolved、能处理反馈', async (who) => {
        const { full } = envs();
        const c = cookieFor(who);
        expect((await teGet(full, c)).status).toBe(200);
        expect((await tePost(full, { action: 'update', id: 'err_1_a', state: 'resolved' }, c)).status).toBe(200);
        expect((await fbPost(full, { action: 'update', id: 'fb_1_a', status: 'resolved' }, c)).status).toBe(200);
    });

    it.each([
        ['reader', () => cookieFor('rd@x.com')],
        ['墓碑成员', () => cookieFor('gone@x.com')],
        ['不在成员表', () => cookieFor('nobody@x.com')],
        ['过期', () => cookieFor('adm@x.com', now() - 10)],
        ['签名被篡改', () => cookieFor('adm@x.com').slice(0, -2) + 'xx'],
        ['别的密钥签的', () => `session=${sign({ sub: 'adm@x.com', exp: now() + 3600 }, 'other-secret')}`],
    ])('%s 的 cookie 三个口子都 401', async (_name, mk) => {
        const { full } = envs();
        const c = mk();
        expect((await teGet(full, c)).status).toBe(401);
        expect((await tePost(full, { action: 'update', id: 'err_1_a', state: 'resolved' }, c)).status).toBe(401);
        expect((await fbPost(full, { action: 'update', id: 'fb_1_a', status: 'resolved' }, c)).status).toBe(401);
    });
});

describe('成员表只认 AUTH_KV', () => {
    it('没绑 AUTH_KV 时，admin cookie 也不过（即使成员记录混在 ERROR_KV/FEEDBACK_KV 里）', async () => {
        const { noAuthKv } = envs();
        const c = cookieFor('adm@x.com');
        expect((await teGet(noAuthKv, c)).status).toBe(401);
        expect((await tePost(noAuthKv, { action: 'update', id: 'err_1_a', state: 'resolved' }, c)).status).toBe(401);
        expect((await fbPost(noAuthKv, { action: 'update', id: 'fb_1_a', status: 'resolved' }, c)).status).toBe(401);
    });
});

describe('原有的共享 token 一路不受影响', () => {
    it('什么都不带仍 401；token 对了照常过', async () => {
        const { full } = envs();
        expect((await teGet(full)).status).toBe(401);
        expect((await teGet(full, undefined, `&token=${VIEW}`)).status).toBe(200);
        expect((await fbPost(full, { action: 'update', id: 'fb_1_a', status: 'resolved' })).status).toBe(401);
        expect((await fbPost(full, { action: 'update', id: 'fb_1_a', status: 'resolved', token: FB_ADMIN })).status).toBe(200);
    });

    it('没配 ERROR_VIEW_TOKEN 且没 cookie 仍是 503（fail-closed 不变）', async () => {
        const { full } = envs();
        const env = { ...full, ERROR_VIEW_TOKEN: undefined };
        expect((await teGet(env)).status).toBe(503);
    });
});

describe('?debug=eo 只给共享 token 或 admin', () => {
    it('reviewer/editor 403，admin 与 token 200', async () => {
        const { full } = envs();
        expect((await teGet(full, cookieFor('rev@x.com'), '&debug=eo')).status).toBe(403);
        expect((await teGet(full, cookieFor('ed@x.com'), '&debug=eo')).status).toBe(403);
        expect((await teGet(full, cookieFor('adm@x.com'), '&debug=eo')).status).toBe(200);
        expect((await teGet(full, undefined, `&debug=eo&token=${VIEW}`)).status).toBe(200);
    });
});
