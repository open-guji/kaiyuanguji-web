/**
 * @jest-environment node
 *
 * 提交带会员身份：登录会员的 voter＝会员号（紧凑 8 位）（服务端从签名 cookie 验出，请求体里任何自报身份都不采信）；
 * 匿名仍是 sha256(aid|ip) 前 16 位；老成员第一次提交时懒补会员号；反馈记录带 member，公开读不返回。
 */
import { createHmac } from 'node:crypto';
import { installFakeInbox } from '../__fixtures__/fakeInbox';

const g = globalThis as unknown as Record<string, unknown>;
const inbox = installFakeInbox(g);
const store = inbox.store;
const SECRET = 'test-secret';
const members = new Map<string, string>();
const authKv = {
    async get(k: string, type?: string) { const v = members.get(k); return v ? (type === 'json' ? JSON.parse(v) : v) : null; },
    async put(k: string, v: string) { members.set(k, v); },
};
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function cookie(email: string, tv = 1) {
    const data = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: email, iat: 1, exp: 4102444800, tv })}`;
    return `session=${data}.${createHmac('sha256', SECRET).update(data).digest('base64url')}`;
}
const base = { book: 'd59f2870u874', vol: 'vol01', a: '12:3:7', item: 'pi_0123456789ab', aid: 'aid_abcdefgh1234', shown: '於', choice: 'char', char: '于' };
function post(body: unknown, headers: Record<string, string> = {}) {
    const request = new Request('https://x/api/cellreview', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    (request as unknown as { eo: unknown }).eo = { clientIp: '1.2.3.4' };
    return { request };
}
const CODE = /^[0-9A-HJKMNP-TV-Z]{8}$/;
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

describe('投票人', () => {
    it('匿名：voter 是 16 位十六进制（旧规则）', async () => {
        await cr.onRequestPost(post(base));
        const [[k]] = votes();
        expect(k).toMatch(/:[0-9a-f]{16}$/);
    });
    it('登录会员：voter＝会员号，并给老成员懒补；换设备同票（aid 不同仍覆盖同一键）', async () => {
        members.set('member:a@x.com', JSON.stringify({ role: 'reader', tokenVersion: 1 }));
        await cr.onRequestPost(post(base, { cookie: cookie('a@x.com') }));
        await cr.onRequestPost(post({ ...base, aid: 'aid_zzzzzzzz9999', char: '於' }, { cookie: cookie('a@x.com') }));
        const code = JSON.parse(members.get('member:a@x.com') as string).code;
        expect(code).toMatch(CODE);
        expect(votes()).toHaveLength(1);
        expect(votes()[0][0].endsWith(`:${code}`)).toBe(true);
        expect(members.get(`membercode:${code}`)).toBe('a@x.com');
    });
    it('cookie 签名不对或版本号对不上：当匿名处理，不采信', async () => {
        members.set('member:a@x.com', JSON.stringify({ role: 'reader', tokenVersion: 2, code: 'K7QM2XR9' }));
        await cr.onRequestPost(post(base, { cookie: cookie('a@x.com', 1) }));
        await cr.onRequestPost(post({ ...base, a: '1:1:1' }, { cookie: `${cookie('a@x.com', 2)}x` }));
        for (const [k] of votes()) expect(k).toMatch(/:[0-9a-f]{16}$/);
    });
    it('请求体里自报的 member／uid／voter 一律忽略', async () => {
        await cr.onRequestPost(post({ ...base, member: 'ZZZZZZZZ', code: 'ZZZZZZZZ', voter: 'ZZZZZZZZ' }));
        expect(votes()[0][0]).not.toContain('ZZZZZZZZ');
    });
});

describe('会员号', () => {
    it('形状 8 位、字母表不含 I L O U，校验位自洽', () => {
        for (let i = 0; i < 200; i += 1) {
            const c = fb.newMemberCode();
            expect(c).toMatch(CODE);
            expect(c).not.toMatch(/[ILOU]/);
            expect(fb.normalizeMemberCode(c)).toBe(c);
        }
    });
    it('输入宽容：小写、横线、空格、O/I/L 写错都能认', () => {
        const c = 'K7QM2XR9';
        const body = c.slice(0, 7);
        const good = fb.newMemberCode();
        expect(fb.normalizeMemberCode(`${good.slice(0, 4)}-${good.slice(4)}`.toLowerCase())).toBe(good);
        expect(fb.normalizeMemberCode(` ${good.slice(0, 4)} ${good.slice(4)} `)).toBe(good);
        expect(fb.normalizeMemberCode(1)).toBeNull();
        expect(body).toBe('K7QM2XR');
    });
    it('抄错一位必被发现；相邻两位互换基本都发现', () => {
        const A = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
        let swapMiss = 0; let swapTotal = 0;
        for (let n = 0; n < 200; n += 1) {
            const c = fb.newMemberCode();
            for (let i = 0; i < 8; i += 1) {
                for (const ch of A) {
                    if (ch === c[i]) continue;
                    expect(fb.normalizeMemberCode(c.slice(0, i) + ch + c.slice(i + 1))).toBeNull();
                }
            }
            for (let i = 0; i < 7; i += 1) {
                if (c[i] === c[i + 1]) continue;
                swapTotal += 1;
                if (fb.normalizeMemberCode(c.slice(0, i) + c[i + 1] + c[i] + c.slice(i + 2))) swapMiss += 1;
            }
        }
        expect(swapMiss / swapTotal).toBeLessThan(0.1);
    });
    it('老成员懒补会员号并写索引，再次读取不变；两人号不同', async () => {
        members.set('member:a@x.com', JSON.stringify({ role: 'reader', tokenVersion: 1, uid: 'legacy-uid' }));
        members.set('member:b@x.com', JSON.stringify({ role: 'reader', tokenVersion: 1 }));
        const a = await fb.ensureMemberId({}, 'a@x.com', null);
        const b = await fb.ensureMemberId({}, 'b@x.com', null);
        expect(a).toMatch(CODE);
        expect(a).not.toBe(b);
        expect(members.get(`membercode:${a}`)).toBe('a@x.com');
        expect(await fb.ensureMemberId({}, 'a@x.com', null)).toBe(a);
        expect(JSON.parse(members.get('member:a@x.com') as string).uid).toBe('legacy-uid');
    });
    it('索引里已被占用的号会重抽', async () => {
        members.set('member:a@x.com', JSON.stringify({ role: 'reader', tokenVersion: 1 }));
        members.set('membercode:00000000', 'someone@x.com');
        let n = 0;
        const spy = jest.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((arr: Uint8Array) => { arr.fill(n === 0 ? 0 : 5); n += 1; return arr; }) as never);
        try {
            const id = await fb.ensureMemberId({}, 'a@x.com', null);
            expect(id).not.toBe('00000000');
            expect(id).toMatch(CODE);
            expect(members.get('membercode:00000000')).toBe('someone@x.com');
        } finally { spy.mockRestore(); }
    });
    it('memberFromRequest：带 id（紧凑）与 code（带横线），匿名为 null', async () => {
        members.set('member:a@x.com', JSON.stringify({ role: 'reader', tokenVersion: 1 }));
        const m = await fb.memberFromRequest(new Request('https://x/', { headers: { cookie: cookie('a@x.com') } }), {});
        expect(m.id).toMatch(CODE);
        expect(m.code).toBe(`${m.id.slice(0, 4)}-${m.id.slice(4)}`);
        expect(m.email).toBe('a@x.com');
        expect(await fb.memberFromRequest(new Request('https://x/'), {})).toBeNull();
    });
});
