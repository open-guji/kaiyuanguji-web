/**
 * @jest-environment node
 *
 * POST /api/auth/nickname：只认验签 cookie；校验长度／邮箱网址／控制字符；空串清除；不碰别的字段。
 */
import { createHmac } from 'node:crypto';
import { installFakeInbox } from '../__fixtures__/fakeInbox';

const g = globalThis as unknown as Record<string, unknown>;
const inbox = installFakeInbox(g);
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
const post = (body: unknown, headers: Record<string, string> = {}) => ({
    request: new Request('https://x/api/auth/nickname', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }),
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fn: any;
beforeAll(async () => {
    g.AUTH_KV = authKv; g.AUTH_JWT_SECRET = SECRET;
    fn = await import('../../../../edge-functions/api/auth/nickname.js');
});
beforeEach(() => { inbox.reset(); inbox.install(); members.clear(); members.set('member:a@x.com', JSON.stringify({ role: 'editor', tokenVersion: 1, uid: 'u1', joinedAt: 5 })); });
afterAll(() => inbox.restore());
const stored = () => JSON.parse(members.get('member:a@x.com') as string);

describe('validateNickname', () => {
    it.each([
        ['  阿  古  ', '阿 古'],
        ['', ''],
        ['   ', ''],
    ])('%j → %j', (raw, want) => expect(fn.validateNickname(raw).nickname).toBe(want));
    it.each(['a@b.com', 'https://x.cn', 'www.abc.com', '<b>x</b>', 'x'.repeat(21), 'a\u0000b', 'a‮b'])('拒绝 %j', (raw) => {
        expect(fn.validateNickname(raw).error).toBeTruthy();
    });
    it('非字符串拒绝', () => expect(fn.validateNickname(123).error).toBeTruthy());
});

describe('POST /api/auth/nickname', () => {
    it('未登录 401，不写库', async () => {
        const res = await fn.onRequestPost(post({ nickname: '甲' }));
        expect(res.status).toBe(401);
        expect(stored().nickname).toBeUndefined();
    });
    it('cookie 签名被改 401', async () => {
        const res = await fn.onRequestPost(post({ nickname: '甲' }, { cookie: `${cookie('a@x.com')}x` }));
        expect(res.status).toBe(401);
    });
    it('登录会员设置昵称：写入且保留 role／uid／joinedAt', async () => {
        const res = await fn.onRequestPost(post({ nickname: ' 校书人 ' }, { cookie: cookie('a@x.com') }));
        expect(res.status).toBe(200);
        expect(JSON.parse(await res.text())).toEqual({ success: true, nickname: '校书人' });
        expect(stored()).toMatchObject({ nickname: '校书人', role: 'editor', uid: 'u1', joinedAt: 5, tokenVersion: 1 });
    });
    it('空串清除昵称', async () => {
        members.set('member:a@x.com', JSON.stringify({ role: 'reader', tokenVersion: 1, nickname: '旧名' }));
        const res = await fn.onRequestPost(post({ nickname: '' }, { cookie: cookie('a@x.com') }));
        expect(res.status).toBe(200);
        expect(stored().nickname).toBeUndefined();
    });
    it('非法昵称 400，不改库', async () => {
        const res = await fn.onRequestPost(post({ nickname: 'a@b.com' }, { cookie: cookie('a@x.com') }));
        expect(res.status).toBe(400);
        expect(stored().nickname).toBeUndefined();
    });
    it('请求体不是 JSON 400；陌生来源 403', async () => {
        expect((await fn.onRequestPost(post('not json', { cookie: cookie('a@x.com') }))).status).toBe(400);
        expect((await fn.onRequestPost(post({ nickname: '甲' }, { cookie: cookie('a@x.com'), origin: 'https://evil.example' }))).status).toBe(403);
    });
});
