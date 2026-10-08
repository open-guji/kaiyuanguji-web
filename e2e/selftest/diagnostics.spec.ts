/**
 * fixtures/diagnostics.ts 的自测（overview#470／#475）：本机起一个会「服务端直出卷四、水合后变回卷一」的小页面，
 * 确认诊断能把这个变化的先后、服务端 title、请求时间线、控制台错误都抓出来，并且能附到报告。不碰线上站点。
 * npm run test:selftest。
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect } from '../fixtures/test';
import { startDiagnostics } from '../fixtures/diagnostics';

let server: http.Server;
let base = '';

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>某书 · 卷四 · 维基文库</title></head>
<body><script src="/static-app.js"></script><main><h1>卷四</h1><select><option selected>维基文库</option><option>四库本</option></select>
<script>
  // 模拟水合后被重置回卷一：先发一个数据请求，再改标题和 h1，并写回地址
  fetch('/data/manifest.json').then(() => {
    setTimeout(() => {
      document.title = '某书 · 卷一 · 维基文库';
      document.querySelector('h1').textContent = '卷一';
      history.replaceState(null, '', '/read/book');
      console.error('模拟的水合错误');
    }, 300);
  });
</script></main></body></html>`;

test.beforeAll(async () => {
    server = http.createServer((req, res) => {
        const url = req.url ?? '/';
        if (url.startsWith('/data/manifest.json')) {
            res.writeHead(200, { 'content-type': 'application/json', age: '661', 'cache-control': 's-maxage=3600' });
            return void res.end('{"ok":true}');
        }
        if (url.endsWith('.js')) {
            res.writeHead(200, { 'content-type': 'text/javascript' });
            return void res.end('void 0');
        }
        if (url.startsWith('/hang')) {
            // 头发出去、体永远不结束：模拟文档响应读不完
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
            return void res.write('<title>半截</title>');
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', age: '12', 'cache-control': 's-maxage=3600, stale-while-revalidate=31532400' });
        res.end(PAGE);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(() => server.close());

test('诊断抓到：服务端 title 是卷四、水合后变卷一的先后、数据请求与缓存头、控制台错误', async ({ page }) => {
    const diag = startDiagnostics(page);
    await page.goto(`${base}/read/book/004`);
    await expect(page.locator('h1')).toHaveText('卷一'); // 等「水合后重置」发生
    const text = await diag.render();

    // 服务端直出的 title（水合之前）是卷四，带缓存头
    expect(text).toContain('title: 某书 · 卷四 · 维基文库');
    expect(text).toMatch(/"age":"12"/);
    // 页面内时间线：先卷四、后卷一，且卷一出现在卷四之后
    const iFour = text.indexOf('h1=「卷四」');
    const iOne = text.indexOf('h1=「卷一」');
    expect(iFour).toBeGreaterThan(-1);
    expect(iOne).toBeGreaterThan(iFour);
    expect(text).toContain('版本=「维基文库」');
    // 请求时间线：数据请求带状态码和缓存头；静态资源（.js）不进来
    expect(text).toMatch(/\[request\] GET 200 http:\/\/127\.0\.0\.1:\d+\/data\/manifest\.json/);
    expect(text).toContain('"age":"661"');
    expect(text).not.toContain('static-app.js'); // 页面确实请求了 /static-app.js，诊断里不该有它（静态资源过滤）
    // 导航与控制台
    expect(text).toMatch(/\[navigated\] http:\/\/127\.0\.0\.1:\d+\/read\/book\/004/);
    expect(text).toMatch(/\[navigated\] http:\/\/127\.0\.0\.1:\d+\/read\/book(?!\/)/); // replaceState 也算
    expect(text).toContain('[console.error] 模拟的水合错误');
    // 失败时页面
    expect(text).toContain('"h1": [\n    "卷一"\n  ]');
});

test('attach：把 diagnostics.txt 和 diagnostics.json 附到报告', async ({ page }, testInfo) => {
    const diag = startDiagnostics(page);
    await page.goto(`${base}/read/book/004`);
    await expect(page.locator('h1')).toHaveText('卷一');
    await diag.attach(testInfo);
    const names = testInfo.attachments.map((a) => a.name);
    expect(names).toEqual(expect.arrayContaining(['diagnostics.txt', 'diagnostics.json']));
    const json = JSON.parse(testInfo.attachments.find((a) => a.name === 'diagnostics.json')!.body!.toString());
    expect(json.serverTitles[0].title).toBe('某书 · 卷四 · 维基文库');
    // 文本附件也要有内容，并且和 JSON 是同一份快照（服务端 title 一致）
    const txt = testInfo.attachments.find((a) => a.name === 'diagnostics.txt')!.body!.toString();
    expect(txt).toContain('title: 某书 · 卷四 · 维基文库');
    expect(txt).toContain('页面内变化时间线');
    expect(json.observed.length).toBeGreaterThanOrEqual(2);
});

test('页面已关闭时 attach 不抛错（诊断不能把失败变成另一个失败）', async ({ page }, testInfo) => {
    const diag = startDiagnostics(page);
    await page.goto(`${base}/read/book/004`);
    await page.close();
    await expect(diag.attach(testInfo)).resolves.toBeUndefined();
});

test('文档响应头来了、体读不完：attach 在限定时间内返回，不把失败变成挂住', async ({ page }, testInfo) => {
    const diag = startDiagnostics(page);
    page.goto(`${base}/hang`, { waitUntil: 'commit' }).catch(() => undefined);
    await page.waitForTimeout(500);
    const t0 = Date.now();
    await diag.attach(testInfo);
    expect(Date.now() - t0).toBeLessThan(7_000);
    const txt = testInfo.attachments.find((a) => a.name === 'diagnostics.txt')!.body!.toString();
    expect(txt).toContain('读不到 body');
});

test('收集期间才到的响应也被等到（不漏掉晚到的文档标题）', async ({ page }) => {
    const diag = startDiagnostics(page);
    await page.goto(`${base}/read/book/004`);
    await expect(page.locator('h1')).toHaveText('卷一');
    // render 里的 collect 会等所有已发出的响应处理；连着调两次，结果的服务端 title 条数一致、不丢
    const a = await diag.render();
    const b = await diag.render();
    expect(a.match(/title: 某书 · 卷四/g)?.length).toBe(1);
    expect(b.match(/title: 某书 · 卷四/g)?.length).toBe(1);
});
