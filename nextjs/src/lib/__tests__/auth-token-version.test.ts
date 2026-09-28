/**
 * @jest-environment node
 *
 * SEC overview#134 的鉴权修复：
 *  H1  成员记录带 tokenVersion 并写进 JWT（tv）；join／改角色／删除时 +1；
 *      所有验会话的地方都比对，旧令牌（没有 tv）一律失效。
 *      复现场景：开放邀请自填别人的邮箱 → 日后管理员给这个邮箱发绑定邀请 → 旧 cookie 不得继承新角色。
 *  M1  去掉 ?token= 查询串鉴权，只认 Authorization: Bearer 或 cookie
 *  M2  成员表不回落到 ERROR_KV／FEEDBACK_KV
 *  L6  /api/auth/probe 下线
 */
import { createHmac } from 'crypto';
import { existsSync } from 'fs';
import { join as pathJoin } from 'path';

const SECRET = 'test-jwt-secret-32bytes-long-1234567890';
const ADMIN_TOKEN = 'test-admin-token';
const VIEW = 'view-token';
const FB_ADMIN = 'fb-admin-token';

function b64url(buf: Buffer) {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function sign(payload: Record<string, unknown>, secret = SECRET) {
    const h = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
    const p = b64url(Buffer.from(JSON.stringify(payload)));
    return `${h}.${p}.${b64url(createHmac('sha256', secret).update(`${h}.${p}`).digest())}`;
}
function decode(token: string) {
    return JSON.parse(Buffer.from(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
}
const nowS = () => Math.floor(Date.now() / 1000);

function makeKv() {
    const m = new Map<string, string>();
    return {
        m,
        async get(k: string, t?: string) {
            const v = m.get(k);
            if (v === undefined) return null;
            if (t === 'json') { try { return JSON.parse(v); } catch { return v; } }
            return v;
        },
        async put(k: string, v: string) { m.set(k, v); },
        async delete(k: string) { m.delete(k); },
        async list(o: { prefix?: string } = {}) {
            return { keys: [...m.keys()].filter((k) => k.startsWith(o.prefix || '')).map((key) => ({ key })), complete: true, cursor: '' };
        },
    };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const EP: Record<string, any> = {};
const API = '../../../../edge-functions/api';
beforeAll(async () => {
    for (const n of ['invite', 'invites', 'join', 'me', 'members', 'revoke']) EP[n] = await import(`${API}/auth/${n}.js`);
    EP.feedback = await import(`${API}/feedback.js`);
    EP.trackError = await import(`${API}/track-error.js`);
    EP.privateText = await import(`${API}/private-text/[[path]].js`);
});

let kv: ReturnType<typeof makeKv>;
let env: Record<string, unknown>;
beforeEach(() => {
    kv = makeKv();
    env = {
        AUTH_JWT_SECRET: SECRET, AUTH_ADMIN_TOKEN: ADMIN_TOKEN, AUTH_KV: kv,
        ERROR_KV: makeKv(), FEEDBACK_KV: makeKv(), ERROR_VIEW_TOKEN: VIEW, FEEDBACK_ADMIN_TOKEN: FB_ADMIN,
        PRIVATE_COS_READ_SECRET_ID: 'ak', PRIVATE_COS_READ_SECRET_KEY: 'sk', PRIVATE_COS_BUCKET: 'b', PRIVATE_COS_REGION: 'ap-singapore',
    };
});

const H = (o: Record<string, string> = {}) => ({ 'Content-Type': 'application/json', ...o });
const req = (path: string, init: RequestInit = {}) => ({ env, request: new Request(`https://x${path}`, init), params: { path: ['Work', 'a.md'] } });
const bearer = { Authorization: `Bearer ${ADMIN_TOKEN}` };
const body = async (r: Response) => JSON.parse(await r.text());
const sessionOf = (r: Response) => (r.headers.get('set-cookie') || '').match(/session=([^;]+)/)?.[1] || '';
const member = (email: string) => JSON.parse(kv.m.get(`member:${email}`) || 'null');

async function newInvite(payload: Record<string, unknown>) {
    const r = await EP.invite.onRequestPost(req('/api/auth/invite', { method: 'POST', headers: H(bearer), body: JSON.stringify(payload) }));
    expect(r.status).toBe(200);
    return (await body(r)).code as string;
}
async function joinWith(code: string, email?: string) {
    const r = await EP.join.onRequestPost(req('/api/auth/join', { method: 'POST', headers: H(), body: JSON.stringify({ code, email }) }));
    expect(r.status).toBe(200);
    return sessionOf(r);
}

/** 用某个 cookie 把所有验会话的端点都打一遍，返回各端点状态码 */
async function probeAll(session: string) {
    const c = { cookie: `session=${session}` };
    global.fetch = jest.fn(async () => new Response('# ok', { status: 200 })) as any;
    const fb = env.FEEDBACK_KV as ReturnType<typeof makeKv>;
    fb.m.set('fb_1_a', JSON.stringify({ id: 'fb_1_a', status: 'pending', reply: '' }));
    return {
        me: (await EP.me.onRequestGet(req('/api/auth/me', { headers: c }))).status,
        members: (await EP.members.onRequestGet(req('/api/auth/members', { headers: c }))).status,
        invites: (await EP.invites.onRequestGet(req('/api/auth/invites', { headers: c }))).status,
        invite: (await EP.invite.onRequestPost(req('/api/auth/invite', { method: 'POST', headers: H(c), body: JSON.stringify({ role: 'reader' }) }))).status,
        revoke: (await EP.revoke.onRequestPost(req('/api/auth/revoke', { method: 'POST', headers: H(c), body: JSON.stringify({ email: 'z@x.com', role: 'reader' }) }))).status,
        trackError: (await EP.trackError.onRequestGet(req('/api/track-error?limit=5', { headers: c }))).status,
        feedbackUpdate: (await EP.feedback.onRequestPost(req('/api/feedback', { method: 'POST', headers: H(c), body: JSON.stringify({ action: 'update', id: 'fb_1_a', status: 'resolved' }) }))).status,
        privateText: (await EP.privateText.onRequestGet(req('/api/private-text/Work/a.md', { headers: c }))).status,
    };
}
const ALL_OK = { me: 200, members: 200, invites: 200, invite: 200, revoke: 200, trackError: 200, feedbackUpdate: 200, privateText: 200 };
const ALL_401 = { me: 401, members: 401, invites: 401, invite: 401, revoke: 401, trackError: 401, feedbackUpdate: 401, privateText: 401 };
const originalFetch = global.fetch;
afterEach(() => { global.fetch = originalFetch; });

describe('H1：开放邀请抢注邮箱，日后绑定邀请不让旧 cookie 继承新角色', () => {
    it('攻击者旧 cookie 在所有验会话的端点都失效，真主人新 cookie 全部可用', async () => {
        // 1) 开放邀请（不绑邮箱，reader），攻击者自填了日后会成为管理员的邮箱
        const open = await newInvite({ role: 'reader' });
        const attacker = await joinWith(open, 'boss@x.com');
        expect(decode(attacker).tv).toBe(1);
        expect(member('boss@x.com')).toMatchObject({ role: 'reader', tokenVersion: 1 });

        // 2) 管理员给这个邮箱发 admin 绑定邀请，真主人 join 覆盖成员记录
        const bound = await newInvite({ role: 'admin', email: 'boss@x.com' });
        const owner = await joinWith(bound);
        expect(member('boss@x.com')).toMatchObject({ role: 'admin', tokenVersion: 2 });
        expect(decode(owner).tv).toBe(2);

        // 3) 攻击者的旧 cookie 处处 401；真主人的处处放行
        expect(await probeAll(attacker)).toEqual(ALL_401);
        expect(await probeAll(owner)).toEqual(ALL_OK);
    });

    it('旧令牌没有 tv 一律失效——成员记录有没有 tokenVersion 都一样', async () => {
        kv.m.set('member:old@x.com', JSON.stringify({ role: 'admin', joinedAt: 1 }));
        kv.m.set('member:new@x.com', JSON.stringify({ role: 'admin', joinedAt: 1, tokenVersion: 1 }));
        const legacy = (sub: string) => sign({ sub, iat: nowS(), exp: nowS() + 3600 });
        expect(await probeAll(legacy('old@x.com'))).toEqual(ALL_401);
        expect(await probeAll(legacy('new@x.com'))).toEqual(ALL_401);
        // 记录没有 tokenVersion 时，哪怕令牌自称 tv 也不认
        expect(await probeAll(sign({ sub: 'old@x.com', tv: 1, iat: nowS(), exp: nowS() + 3600 }))).toEqual(ALL_401);
        // 非整数、0、字符串形式的版本号都不认
        for (const tv of ['1', 0, 1.5, null]) {
            kv.m.set('member:odd@x.com', JSON.stringify({ role: 'admin', joinedAt: 1, tokenVersion: tv }));
            expect((await EP.me.onRequestGet(req('/api/auth/me', { headers: { cookie: `session=${sign({ sub: 'odd@x.com', tv, exp: nowS() + 3600 })}` } }))).status).toBe(401);
        }
    });

    it('改角色 +1：保留 joinedAt，但旧 cookie 立即失效（不能只比 iat 与 joinedAt）', async () => {
        const s = await joinWith(await newInvite({ role: 'editor', email: 'ed@x.com' }));
        const joinedAt = member('ed@x.com').joinedAt;
        const r = await EP.revoke.onRequestPost(req('/api/auth/revoke', { method: 'POST', headers: H(bearer), body: JSON.stringify({ email: 'ed@x.com', role: 'reviewer' }) }));
        expect(r.status).toBe(200);
        expect(member('ed@x.com')).toMatchObject({ role: 'reviewer', joinedAt, tokenVersion: 2 });
        expect((await EP.me.onRequestGet(req('/api/auth/me', { headers: { cookie: `session=${s}` } }))).status).toBe(401);
    });

    it('删除写墓碑保留 tokenVersion；再加回来版本号接着涨，删除前的 cookie 仍然无效', async () => {
        const s1 = await joinWith(await newInvite({ role: 'reviewer', email: 'rv@x.com' }));
        const del = await EP.revoke.onRequestPost(req('/api/auth/revoke', { method: 'POST', headers: H(bearer), body: JSON.stringify({ email: 'rv@x.com' }) }));
        expect(del.status).toBe(200);
        expect(member('rv@x.com')).toMatchObject({ _deleted: true, tokenVersion: 2 });
        expect((await EP.me.onRequestGet(req('/api/auth/me', { headers: { cookie: `session=${s1}` } }))).status).toBe(401);
        // 墓碑不出现在成员列表
        expect((await body(await EP.members.onRequestGet(req('/api/auth/members', { headers: bearer })))).members).toHaveLength(0);

        const s2 = await joinWith(await newInvite({ role: 'reviewer', email: 'rv@x.com' }));
        expect(decode(s2).tv).toBe(3);
        expect((await EP.me.onRequestGet(req('/api/auth/me', { headers: { cookie: `session=${s1}` } }))).status).toBe(401);
        expect((await EP.me.onRequestGet(req('/api/auth/me', { headers: { cookie: `session=${s2}` } }))).status).toBe(200);
    });

    it('me 滑动续期：续出来的令牌带同一个 tv；版本号对不上的不续', async () => {
        kv.m.set('member:u@x.com', JSON.stringify({ role: 'reader', joinedAt: 1, tokenVersion: 4 }));
        const nearExpiry = (tv: number) => sign({ sub: 'u@x.com', tv, iat: nowS() - 170 * 86400, exp: nowS() + 86400 });
        const ok = await EP.me.onRequestGet(req('/api/auth/me', { headers: { cookie: `session=${nearExpiry(4)}` } }));
        expect(ok.status).toBe(200);
        const renewed = sessionOf(ok);
        expect(renewed).not.toBe('');
        expect(decode(renewed).tv).toBe(4);
        const stale = await EP.me.onRequestGet(req('/api/auth/me', { headers: { cookie: `session=${nearExpiry(3)}` } }));
        expect(stale.status).toBe(401);
        expect(sessionOf(stale)).toBe('');
    });
});

describe('M1：不再认 ?token= 查询串，只认 Authorization: Bearer', () => {
    it.each(['members', 'invites'])('/api/auth/%s', async (n) => {
        expect((await EP[n].onRequestGet(req(`/api/auth/${n}?token=${ADMIN_TOKEN}`))).status).toBe(401);
        expect((await EP[n].onRequestGet(req(`/api/auth/${n}`, { headers: bearer }))).status).toBe(200);
    });

    it('/api/auth/invite 与 /api/auth/revoke', async () => {
        const inv = (path: string, headers = H()) => EP.invite.onRequestPost(req(path, { method: 'POST', headers, body: JSON.stringify({ role: 'reader' }) }));
        expect((await inv(`/api/auth/invite?token=${ADMIN_TOKEN}`)).status).toBe(401);
        expect((await inv('/api/auth/invite', H(bearer))).status).toBe(200);
        const rev = (path: string, headers = H()) => EP.revoke.onRequestPost(req(path, { method: 'POST', headers, body: JSON.stringify({ email: 'a@x.com', role: 'reader' }) }));
        expect((await rev(`/api/auth/revoke?token=${ADMIN_TOKEN}`)).status).toBe(401);
        expect((await rev('/api/auth/revoke', H(bearer))).status).toBe(200);
    });

    it('/api/track-error 列表与 summary', async () => {
        expect((await EP.trackError.onRequestGet(req(`/api/track-error?token=${VIEW}`))).status).toBe(401);
        expect((await EP.trackError.onRequestGet(req('/api/track-error', { headers: { Authorization: `Bearer ${VIEW}` } }))).status).toBe(200);
        expect((await EP.trackError.onRequestGet(req(`/api/track-error?summary=1&token=${VIEW}`))).status).toBe(401);
        expect((await EP.trackError.onRequestGet(req('/api/track-error?summary=1', { headers: { Authorization: `Bearer ${VIEW}` } }))).status).toBe(200);
    });

    it('/api/feedback 管理读与 summary', async () => {
        const fb = env.FEEDBACK_KV as ReturnType<typeof makeKv>;
        fb.m.set('fb_1_a', JSON.stringify({ id: 'fb_1_a', type: 'bug', content: 'x', visibility: 'hidden' }));
        const items = async (path: string, headers = {}) => (await body(await EP.feedback.onRequestGet(req(path, { headers })))).items;
        expect(await items(`/api/feedback?token=${FB_ADMIN}`)).toHaveLength(0); // 查询串带 token 只当公开读
        expect(await items('/api/feedback', { Authorization: `Bearer ${FB_ADMIN}` })).toHaveLength(1);
        expect((await EP.feedback.onRequestGet(req(`/api/feedback?summary=1&token=${FB_ADMIN}`))).status).toBe(401);
        expect((await EP.feedback.onRequestGet(req('/api/feedback?summary=1', { headers: { Authorization: `Bearer ${FB_ADMIN}` } }))).status).toBe(200);
    });

    it('edge-functions 源码里不再有 searchParams.get(\'token\')', async () => {
        const { execSync } = await import('child_process');
        const root = pathJoin(__dirname, '../../../../edge-functions/api');
        const hits = execSync(`grep -rn "searchParams.get('token')" ${root} || true`).toString().trim();
        expect(hits).toBe('');
    });
});

describe('M2：成员表只认 AUTH_KV', () => {
    it.each(['members', 'invites'])('/api/auth/%s 没绑 AUTH_KV 时不去读 ERROR_KV／FEEDBACK_KV', async (n) => {
        const seeded = makeKv();
        seeded.m.set('member:a@x.com', JSON.stringify({ role: 'admin', tokenVersion: 1 }));
        seeded.m.set('invite:h', JSON.stringify({ role: 'reader', createdAt: 1 }));
        env = { ...env, AUTH_KV: undefined, ERROR_KV: seeded, FEEDBACK_KV: seeded };
        const cookie = `session=${sign({ sub: 'a@x.com', tv: 1, exp: nowS() + 3600 })}`;
        expect((await EP[n].onRequestGet(req(`/api/auth/${n}`, { headers: { cookie } }))).status).toBe(401);
        expect((await EP[n].onRequestGet(req(`/api/auth/${n}`, { headers: bearer }))).status).toBe(503);
    });
});

describe('L6：/api/auth/probe 下线', () => {
    it('probe.js 不存在', () => {
        expect(existsSync(pathJoin(__dirname, '../../../../edge-functions/api/auth/probe.js'))).toBe(false);
    });
});
