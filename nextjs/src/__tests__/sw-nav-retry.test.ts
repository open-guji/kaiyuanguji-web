/**
 * @jest-environment node
 *
 * public/sw-nav-retry.js：/read/、/item/ 整页导航失败自动重试一次（overview#322）。
 */
import { describe, it, expect, jest, beforeAll } from '@jest/globals';

type Req = { mode: string; method: string; url: string };
type Res = { status: number };
let sw: {
    navigateWithRetry: (r: Req, f: (r: Req) => Promise<Res>, s: (ms: number) => Promise<void>) => Promise<Res>;
    shouldHandle: (r: Req, origin: string) => boolean;
};
const listeners: Record<string, unknown> = {};

beforeAll(() => {
    (globalThis as Record<string, unknown>).self = {
        addEventListener: (type: string, fn: unknown) => { listeners[type] = fn; },
        location: { origin: 'https://www.kaiyuanguji.com' },
    };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    sw = require('../../public/sw-nav-retry.js');
});

const ORIGIN = 'https://www.kaiyuanguji.com';
const nav = (path: string, over: Partial<Req> = {}): Req => ({ mode: 'navigate', method: 'GET', url: `${ORIGIN}${path}`, ...over });
const noSleep = async () => {};

describe('shouldHandle：只管本站 /read/、/item/ 的整页 GET 导航', () => {
    it.each(['/read/d59f2nkglgcj', '/read/d59f2nkglgcj/002', '/item/988g1iz6dg'])('管：%s', (p) => {
        expect(sw.shouldHandle(nav(p), ORIGIN)).toBe(true);
    });
    it.each<[string, Req]>([
        ['首页', nav('/')],
        ['阅读首页', nav('/read')],
        ['元数据页', nav('/book-index?id=x')],
        ['非整页（fetch／RSC）', nav('/read/x', { mode: 'cors' })],
        ['POST', nav('/item/x', { method: 'POST' })],
        ['别的站', { mode: 'navigate', method: 'GET', url: 'https://example.com/read/x' }],
    ])('不管：%s', (_n, r) => {
        expect(sw.shouldHandle(r, ORIGIN)).toBe(false);
    });
    it('注册了 install／activate／fetch', () => {
        expect(Object.keys(listeners).sort()).toEqual(['activate', 'fetch', 'install']);
    });
});

describe('navigateWithRetry', () => {
    it('第一次就成功：只请求一次', async () => {
        const f = jest.fn(async () => ({ status: 200 }));
        expect(await sw.navigateWithRetry(nav('/read/x'), f, noSleep)).toEqual({ status: 200 });
        expect(f).toHaveBeenCalledTimes(1);
    });
    it('404、308 等不重试', async () => {
        const f = jest.fn(async () => ({ status: 404 }));
        expect((await sw.navigateWithRetry(nav('/read/x'), f, noSleep)).status).toBe(404);
        expect(f).toHaveBeenCalledTimes(1);
    });
    it('网络错（边缘断开）→ 等一下再请求一次', async () => {
        const f = jest.fn<() => Promise<Res>>().mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce({ status: 200 });
        const sleep = jest.fn(async () => {});
        expect(await sw.navigateWithRetry(nav('/item/x'), f, sleep)).toEqual({ status: 200 });
        expect(f).toHaveBeenCalledTimes(2);
        expect(sleep).toHaveBeenCalledWith(300);
    });
    it('5xx（冷渲染临时故障）→ 再请求一次', async () => {
        const f = jest.fn<() => Promise<Res>>().mockResolvedValueOnce({ status: 500 }).mockResolvedValueOnce({ status: 200 });
        expect((await sw.navigateWithRetry(nav('/item/x'), f, noSleep)).status).toBe(200);
    });
    it('两次都失败：只重试一次；5xx 后网络错交回第一次的 5xx，两次网络错就抛', async () => {
        const a = jest.fn<() => Promise<Res>>().mockResolvedValueOnce({ status: 503 }).mockRejectedValueOnce(new TypeError('x'));
        expect((await sw.navigateWithRetry(nav('/read/x'), a, noSleep)).status).toBe(503);
        const b = jest.fn<() => Promise<Res>>().mockRejectedValue(new TypeError('Failed to fetch'));
        await expect(sw.navigateWithRetry(nav('/read/x'), b, noSleep)).rejects.toThrow('Failed to fetch');
        expect(b).toHaveBeenCalledTimes(2);
    });
});
