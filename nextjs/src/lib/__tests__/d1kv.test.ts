/**
 * @jest-environment node
 *
 * d1Kv 替身的 get／put／delete／list，键里带 @ 的成员记录、expirationTtl、cursor 翻页。
 */
import { installFakeInbox } from '../__fixtures__/fakeInbox';

const g = globalThis as unknown as Record<string, unknown>;
const inbox = installFakeInbox(g);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let F: any;
const ctx = { env: { WEB_INBOX_URL: 'https://w.example', WEB_INBOX_TOKEN: 't' } };

beforeAll(async () => { F = await import('../../../../edge-functions/api/feedback.js'); });
beforeEach(() => { inbox.reset(); inbox.install(); });
afterAll(() => inbox.restore());

describe('d1Kv', () => {
    it('put／get：json 与文本都原样回；键里的 @ 转码存、不影响读', async () => {
        const kv = F.d1Kv(ctx);
        await kv.put('member:a.b+c@x.com', JSON.stringify({ role: 'admin' }));
        await kv.put('oauth_code_jti:abc', '1');
        expect(await kv.get('member:a.b+c@x.com', 'json')).toEqual({ role: 'admin' });
        expect(await kv.get('oauth_code_jti:abc')).toBe('1');
        expect(await kv.get('member:none', 'json')).toBeNull();
        expect([...inbox.store.keys()].some((k) => k.includes('@'))).toBe(false);
    });
    it('expirationTtl 过期后读不到、list 里也没有', async () => {
        const kv = F.d1Kv(ctx);
        const now = Date.now();
        const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
        await kv.put('ratelimit:x', '{"count":1}', { expirationTtl: 60 });
        expect(await kv.get('ratelimit:x', 'json')).toEqual({ count: 1 });
        spy.mockReturnValue(now + 61_000);
        expect(await kv.get('ratelimit:x', 'json')).toBeNull();
        expect((await kv.list({ prefix: 'ratelimit:' })).keys).toHaveLength(0);
        spy.mockRestore();
    });
    it('delete；list 按前缀、key 升序、cursor 翻页', async () => {
        const kv = F.d1Kv(ctx);
        for (const k of ['fb_3', 'fb_1', 'fb_2', 'other:1']) await kv.put(k, '{}');
        const p1 = await kv.list({ prefix: 'fb_', limit: 2 });
        expect(p1.keys.map((x: { key: string }) => x.key)).toEqual(['fb_1', 'fb_2']);
        expect(p1.complete).toBe(false);
        const p2 = await kv.list({ prefix: 'fb_', limit: 2, cursor: p1.cursor });
        expect(p2.keys.map((x: { key: string }) => x.key)).toEqual(['fb_3']);
        expect(p2.complete).toBe(true);
        await kv.delete('fb_2');
        expect((await kv.list({ prefix: 'fb_' })).keys).toHaveLength(2);
    });
});
