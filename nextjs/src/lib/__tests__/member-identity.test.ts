/**
 * @jest-environment node
 *
 * 提交带会员身份：登录会员的 voter＝成员 uid（服务端从签名 cookie 验出，请求体里任何自报身份都不采信）；
 * 匿名仍是 sha256(aid|ip) 前 16 位；老成员第一次提交时懒补 uuidv7；反馈记录带 member，公开读不返回。
 */
import { createHmac } from 'node:crypto';
import { installFakeInbox } from '../__fixtures__/fakeInbox';

const g = globalThis as unknown as Record<string, unknown>;
const inbox = installFakeInbox(g);
const store = inbox.store;
const SECRET = 'test-secret';
const members = new Map<string, string>();
const authKv = {
    async get(k: string) { const v = members.get(k); return v ? JSON.parse(v) : null; },
    async put(k: string, v: string) { members.set(k, v); },
};
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function cookie(email: string, tv = 1) {
    const data = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: email, iat: 1, exp: 4102444800, tv })}`;
    return `session=${data}.${createHmac('sha256', SECRET).update(data).digest('base64url')}`;
}
const base = { book: 'd59f2870u874', vol: 'vol01', a: '12:3:7', rev: 'vol01-r1', aid: 'aid_abcdefgh1234', shown: '於', choice: 'char', char: '于' };
function post(body: unknown, headers: Record<string, string> = {}) {
    const request = new Request('https://x/api/cellreview', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    (request as unknown as { eo: unknown }).eo = { clientIp: '1.2.3.4' };
    return { request };
}
const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const votes = () => [...store.entries()].filter(([k]) => k.startsWith('cr:'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cr: any; let fb: any;
beforeAll(async () => {
    g.AUTH_KV = authKv; g.AUTH_JWT_SECRET = SECRET;
    cr = await import('../../../../edge-functions/api/cellreview.js');
    fb = await import('../../../../edge-functions/api/feedback.js');
});
beforeEach(() => { inbox.reset(); inbox.install(); members.clear(); cr.resetMemRateLimit(); });
afterAll(() => inbox.restore());

describe('uuidv7', () => {
    it('版本位与变体位正确，且按时间递增', () => {
        const a = fb.uuidv7(1_700_000_000_000); const b = fb.uuidv7(1_700_000_000_001);
        expect(a).toMatch(UUID7);
        expect(a.slice(0, 13) < b.slice(0, 13)).toBe(true);
    });
});

describe('投票人', () => {
    it('匿名：voter 是 16 位十六进制（旧规则）', async () => {
        await cr.onRequestPost(post(base));
        const [[k]] = votes();
        expect(k).toMatch(/:[0-9a-f]{16}$/);
    });
    it('登录会员：voter＝uid，并给老成员懒补 uid；换设备同票（aid 不同仍覆盖同一键）', async () => {
        members.set('member:a@x.com', JSON.stringify({ role: 'reader', tokenVersion: 1 }));
        await cr.onRequestPost(post(base, { cookie: cookie('a@x.com') }));
        await cr.onRequestPost(post({ ...base, aid: 'aid_zzzzzzzz9999', char: '於' }, { cookie: cookie('a@x.com') }));
        const uid = JSON.parse(members.get('member:a@x.com') as string).uid;
        expect(uid).toMatch(UUID7);
        expect(votes()).toHaveLength(1);
        expect(votes()[0][0].endsWith(`:${uid}`)).toBe(true);
    });
    it('cookie 签名不对或版本号对不上：当匿名处理，不采信', async () => {
        members.set('member:a@x.com', JSON.stringify({ role: 'reader', tokenVersion: 2, uid: '018f0000-0000-7000-8000-000000000000' }));
        await cr.onRequestPost(post(base, { cookie: cookie('a@x.com', 1) }));
        await cr.onRequestPost(post({ ...base, a: '1:1:1' }, { cookie: `${cookie('a@x.com', 2)}x` }));
        for (const [k] of votes()) expect(k).toMatch(/:[0-9a-f]{16}$/);
    });
    it('请求体里自报的 member／uid／voter 一律忽略', async () => {
        await cr.onRequestPost(post({ ...base, uid: '018f0000-0000-7000-8000-000000000001' }));
        expect(votes()[0][0]).not.toContain('018f0000');
    });
});

describe('反馈', () => {
    it('登录会员提交的反馈记录带 member，公开读不返回', async () => {
        members.set('member:a@x.com', JSON.stringify({ role: 'reader', tokenVersion: 1, uid: '018f0000-0000-7000-8000-0000000000aa' }));
        const m = await fb.memberFromRequest(new Request('https://x/', { headers: { cookie: cookie('a@x.com') } }), {});
        expect(m).toMatchObject({ uid: '018f0000-0000-7000-8000-0000000000aa', email: 'a@x.com' });
        expect(await fb.memberFromRequest(new Request('https://x/'), {})).toBeNull();
    });
});
