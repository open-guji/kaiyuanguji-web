/**
 * @jest-environment node
 *
 * 网站票双写 D1：mirrorToInbox 开关、缺配置、键校验、失败不抛错。
 */
const g = globalThis as unknown as Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mirror: any;
const calls: Array<{ url: string; init: RequestInit }> = [];
const realFetch = globalThis.fetch;

beforeAll(async () => {
    mirror = (await import('../../../../edge-functions/api/feedback.js')).mirrorToInbox;
});
beforeEach(() => {
    calls.length = 0;
    g.fetch = async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response('{}', { status: 200 }); };
});
afterAll(() => { g.fetch = realFetch; });

const env = (o: Record<string, string> = {}) => ({ env: { WEB_INBOX_DUALWRITE: '1', WEB_INBOX_URL: 'https://w.example/', WEB_INBOX_TOKEN: 't', ...o } });
const val = { v: 1, voter: 'x' };

describe('mirrorToInbox', () => {
    it('开关未开：不请求', async () => {
        expect(await mirror(env({ WEB_INBOX_DUALWRITE: '0' }), 'thread', 'tv:a:b', val, 1)).toBe('off');
        expect(calls).toHaveLength(0);
    });
    it('开关开：一次 POST 到 /v1/web/inbox，带令牌与 items', async () => {
        expect(await mirror(env(), 'charfix', 'cf:a:b', val, 5)).toBe('ok');
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('https://w.example/v1/web/inbox');
        expect(JSON.parse(calls[0].init.body as string)).toEqual({ items: [{ kind: 'charfix', key: 'cf:a:b', value: val, ts: 5 }] });
        expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer t');
    });
    it('默认地址与 FEEDBACK_ADMIN_TOKEN；有 waitUntil 时后台', async () => {
        const waited: Promise<unknown>[] = [];
        const ctx = { env: { WEB_INBOX_DUALWRITE: '1', FEEDBACK_ADMIN_TOKEN: 'adm' }, waitUntil: (p: Promise<unknown>) => { waited.push(p); } };
        expect(await mirror(ctx, 'thread', 'tv:a', val, 1)).toBe('bg');
        await Promise.all(waited);
        expect(calls[0].url).toBe('https://data.open-guji.com/v1/web/inbox');
        expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer adm');
    });
    it('缺令牌／非法键或 kind：跳过', async () => {
        expect(await mirror({ env: { WEB_INBOX_DUALWRITE: '1' } }, 'thread', 'tv:a', val, 1)).toBe('skip');
        expect(await mirror(env(), 'thread', 'tv:a b', val, 1)).toBe('skip');
        expect(await mirror(env(), 'nope', 'tv:a', val, 1)).toBe('skip');
        expect(calls).toHaveLength(0);
    });
    it('Worker 报错或抛错：返回 fail，不抛', async () => {
        g.fetch = async () => new Response('x', { status: 502 });
        expect(await mirror(env(), 'thread', 'tv:a', val, 1)).toBe('fail');
        g.fetch = async () => { throw new Error('boom'); };
        expect(await mirror(env(), 'thread', 'tv:a', val, 1)).toBe('fail');
    });
});
