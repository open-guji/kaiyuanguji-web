/**
 * fixtures/test.ts 的网络重试自测（overview#345）：本机起一个会「先重置前 N 次连接」的小服务，
 * 不碰任何线上站点、不依赖 TARGET。npm run test:selftest。
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect } from '../fixtures/test';
import { withNetRetry } from '../fixtures/net-retry';

let server: http.Server;
let base = '';
/** 每个路径被请求的次数 */
const hits = new Map<string, number>();
/** 路径 → 前 n 次的行为：reset＝RST 断连；429／522／404＝返回该状态码 */
let plan = new Map<string, Array<'reset' | number>>();

test.beforeAll(async () => {
    server = http.createServer((req, res) => {
        const path = req.url ?? '/';
        const n = (hits.get(path) ?? 0) + 1;
        hits.set(path, n);
        const step = plan.get(path)?.[n - 1];
        if (step === 'reset') return void req.socket.resetAndDestroy();
        if (typeof step === 'number') {
            res.writeHead(step, { 'retry-after': '0', 'content-type': 'text/plain' });
            return void res.end(`status ${step}`);
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(req.method === 'GET' ? '<title>ok</title><h1 id="h">hello</h1>' : 'posted');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(() => server.close());
test.beforeEach(() => {
    hits.clear();
    plan = new Map();
});

test('request.get：连接重置 2 次后成功', async ({ request }) => {
    plan.set('/a', ['reset', 'reset']);
    const res = await request.get(`${base}/a`);
    expect(res.status()).toBe(200);
    expect(hits.get('/a')).toBe(3);
});

test('page.goto：ERR_CONNECTION_RESET 重试后成功', async ({ page }) => {
    plan.set('/p', ['reset']);
    await page.goto(`${base}/p`);
    await expect(page.locator('#h')).toHaveText('hello');
    expect(hits.get('/p')).toBeGreaterThanOrEqual(2); // Chromium 自己也可能多补一次
});

test('自己 browser.newContext() 出来的页也带重试', async ({ browser }) => {
    plan.set('/b', ['reset']);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${base}/b`);
    await expect(page.locator('#h')).toHaveText('hello');
    expect(hits.get('/b')).toBeGreaterThanOrEqual(2);
    await ctx.close();
});

test('GET 遇到 429／522 重试', async ({ request }) => {
    plan.set('/s', [429, 522]);
    const res = await request.get(`${base}/s`);
    expect(res.status()).toBe(200);
    expect(hits.get('/s')).toBe(3);
});

test('404 是站点自己的回答，不重试', async ({ request }) => {
    plan.set('/nf', [404]);
    const res = await request.get(`${base}/nf`);
    expect(res.status()).toBe(404);
    expect(hits.get('/nf')).toBe(1);
});

test('POST 遇到 429 不重试（非幂等）', async ({ request }) => {
    plan.set('/post', [429]);
    const res = await request.post(`${base}/post`);
    expect(res.status()).toBe(429);
    expect(hits.get('/post')).toBe(1);
});

test('断言失败不重试：goto 成功后页面内容不对，只请求 1 次', async ({ page }) => {
    await page.goto(`${base}/c`);
    await expect(page.locator('#h')).toHaveText('不是这句', { timeout: 500 }).catch(() => undefined);
    expect(hits.get('/c')).toBe(1);
});

test('withNetRetry：重试用尽后抛出原错误，共 4 次尝试', async () => {
    let calls = 0;
    await expect(
        withNetRetry('x', async () => {
            calls++;
            throw new Error('net::ERR_CONNECTION_RESET at /x');
        }, { backoffMs: () => 0 }),
    ).rejects.toThrow('ERR_CONNECTION_RESET');
    expect(calls).toBe(4);
});

test('withNetRetry：非网络错误不重试', async () => {
    let calls = 0;
    await expect(
        withNetRetry('x', async () => {
            calls++;
            throw new Error('expect(received).toBe(expected)');
        }, { backoffMs: () => 0 }),
    ).rejects.toThrow('expect(received)');
    expect(calls).toBe(1);
});
