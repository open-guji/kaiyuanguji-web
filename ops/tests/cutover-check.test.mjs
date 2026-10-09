// node --test ops/tests/cutover-check.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import {
    runCutoverCheck, renderMarkdown, parseArgs, uiVersionFromLock, metaContent, robotsVerdict, httpGet, ITEMS,
} from '../cutover-check.mjs';

const NOW = new Date('2026-09-28T00:00:00Z');
const WEB = 'abcdef1234567890';

/** 一个「切站成功」的全栈 www；overrides 按 URL 改个别响应 */
function fakeSite(host, overrides = {}) {
    const html = (extra = '') => `<html><head><meta name="bim-ui-version" content="0.9.8"/>${extra}<title>开源古籍</title></head><body></body></html>`;
    const routes = {
        [`https://${host}/`]: { status: 200, body: html(), cert: { validTo: new Date('2026-12-24T00:00:00Z') } },
        [`https://${host}/robots.txt`]: { status: 200, body: 'User-Agent: *\nAllow: /\nDisallow: /private/\n\nSitemap: https://www.kaiyuanguji.com/sitemap.xml\n' },
        [`https://${host}/book-index?id=${ITEMS[0].id}`]: { status: 308, headers: { location: `/item/${ITEMS[0].id}` } },
        [`https://${host}/api/feedback`]: { status: 200, body: '{"success":true,"items":[]}' },
        [`https://${host}/api/auth/me`]: { status: 401, body: '{"success":false}' },
        [`https://${host}/api/version`]: { status: 404, body: '<html>' },
        [`https://${host}/sitemap-index.xml`]: { status: 200, body: '<sitemapindex><sitemap><loc>https://www.kaiyuanguji.com/sitemaps/work-001.xml</loc></sitemap></sitemapindex>' },
        'https://data.kaiyuanguji.com/latest.json': { status: 200, body: JSON.stringify({ commitId: '501935e5be70', webCommitId: WEB }) },
        [`http://${host}/`]: { status: 301, headers: { location: `https://${host}/` } },
        'https://kaiyuanguji.com/': { status: 301, headers: { location: 'https://www.kaiyuanguji.com/' } },
    };
    for (const it of ITEMS) {
        routes[`https://${host}/item/${it.id}`] = { status: 200, body: `<html><head><title>${it.title}（某） - 开源古籍</title></head></html>` };
    }
    Object.assign(routes, overrides);
    const calls = [];
    const get = async (url, opts) => {
        calls.push({ url, opts });
        const key = url.replace(/\?_=\d+$/, '');
        const r = routes[key];
        if (!r) throw new Error(`未模拟：${url}`);
        if (r instanceof Error) throw r;
        return { status: r.status, headers: r.headers ?? {}, body: r.body ?? '', cert: r.cert ?? null };
    };
    return { get, calls, html };
}

const run = (host, site, extra = {}) => runCutoverCheck({
    host, get: site.get, expectedUi: '0.9.8', uiAtCommit: (sha) => (sha === WEB ? '0.9.8' : null), now: () => NOW, ...extra,
});
const byId = (rep, id) => rep.results.find((r) => r.id === id);

test('切站成功：回滚项全过，退出 ok', async () => {
    const site = fakeSite('www.kaiyuanguji.com');
    const rep = await run('www.kaiyuanguji.com', site);
    const bad = rep.results.filter((r) => r.status === 'fail');
    assert.deepEqual(bad, []);
    assert.equal(rep.ok, true);
    assert.equal(byId(rep, 'api-version').status, 'skip');
    assert.equal(byId(rep, 'apex').level, 'block', '目标是 www 时裸域跳转是回滚项');
    assert.match(renderMarkdown(rep), /结论：✅ 回滚项全过/);
});

test('全程只读：只发 GET 到目标域名、裸域与数据指针', async () => {
    const site = fakeSite('www.kaiyuanguji.com');
    await run('www.kaiyuanguji.com', site);
    for (const c of site.calls) {
        assert.match(c.url, /^https?:\/\/(www\.kaiyuanguji\.com|kaiyuanguji\.com|data\.kaiyuanguji\.com)\//);
        assert.equal(c.opts?.method, undefined);
    }
    // book-index 按站外整页导航的样子发，否则中间件放过、不 308
    assert.equal(site.calls.find((c) => c.url.includes('/book-index'))?.opts.headers['sec-fetch-dest'], 'document');
});

test('域名还在旧静态项目上：条目页 404、book-index 200 → 回滚', async () => {
    const host = 'www.kaiyuanguji.com';
    const over = { [`https://${host}/book-index?id=${ITEMS[0].id}`]: { status: 200, body: '<html>' } };
    for (const it of ITEMS) over[`https://${host}/item/${it.id}`] = { status: 404, body: '<title>404</title>' };
    const rep = await run(host, fakeSite(host, over));
    assert.equal(rep.ok, false);
    for (const it of ITEMS) assert.match(byId(rep, `item:${it.id}`).detail, /旧静态站/);
    assert.equal(byId(rep, 'book-index').status, 'fail');
    assert.match(renderMarkdown(rep), /❌ 4 个回滚项失败/);
});

test('绑成了测试站构建：noindex、角标、robots 全禁都抓到', async () => {
    const host = 'www.kaiyuanguji.com';
    const site = fakeSite(host);
    const over = {
        [`https://${host}/`]: { status: 200, body: site.html('<meta name="robots" content="noindex"/><div data-testid="staging-badge">测试站</div>'), cert: { validTo: new Date('2027-01-01') } },
        [`https://${host}/robots.txt`]: { status: 200, body: 'User-Agent: *\nDisallow: /\n' },
    };
    const rep = await run(host, fakeSite(host, over));
    for (const id of ['noindex', 'badge', 'robots']) assert.equal(byId(rep, id).status, 'fail', id);
    assert.equal(rep.ok, false);
});

test('robots：空的 Disallow: 算允许，行尾注释忽略', async () => {
    const host = 'www.kaiyuanguji.com';
    const robotsIs = async (body) => byId(await run(host, fakeSite(host, { [`https://${host}/robots.txt`]: { status: 200, body } })), 'robots');
    let r = await robotsIs('User-agent: *\nDisallow:\n');
    assert.equal(r.status, 'pass');
    assert.match(r.detail, /空的 Disallow:/);
    assert.equal((await robotsIs('User-agent: *\nAllow: / # 全站开放\n')).status, 'pass');
    assert.equal((await robotsIs('User-agent: *\nDisallow:   # 不禁止任何路径\n')).status, 'pass');
    assert.equal((await robotsIs('User-agent: *\nDisallow: / # 测试站\n')).status, 'fail');
    assert.equal((await robotsIs('User-agent: *\nDisallow: /private/\n')).status, 'fail');
    assert.equal((await robotsIs('# Allow: /\nUser-agent: *\n')).status, 'fail');
});

test('robotsVerdict', () => {
    assert.deepEqual(robotsVerdict('User-agent: *\r\nDisallow:\r\n'), { disallowAll: false, allowRoot: false, emptyDisallow: true });
    assert.deepEqual(robotsVerdict('allow: /#x\nDISALLOW : /'), { disallowAll: true, allowRoot: true, emptyDisallow: false });
    assert.deepEqual(robotsVerdict('Disallow: /admin/\n# Disallow: /'), { disallowAll: false, allowRoot: false, emptyDisallow: false });
    assert.deepEqual(robotsVerdict(''), { disallowAll: false, allowRoot: false, emptyDisallow: false });
});

test('/api/auth/me 503：说明控制台配置没带进去', async () => {
    const host = 'www.kaiyuanguji.com';
    const rep = await run(host, fakeSite(host, {
        [`https://${host}/api/auth/me`]: { status: 503, body: '{"success":false,"error":"服务未配置 AUTH_JWT_SECRET"}' },
    }));
    const r = byId(rep, 'auth-me');
    assert.equal(r.status, 'fail');
    assert.equal(r.level, 'block');
    assert.match(r.detail, /环境变量没带进/);
});

test('UI 版本：≠ main 但 = promote 那版 → 关注项；都不等 → 回滚项', async () => {
    const host = 'www.kaiyuanguji.com';
    let rep = await run(host, fakeSite(host), { expectedUi: '0.9.9' });
    assert.equal(byId(rep, 'ui').level, 'watch');
    assert.equal(byId(rep, 'ui').status, 'fail');
    assert.equal(rep.ok, true);

    rep = await run(host, fakeSite(host), { expectedUi: '0.9.9', uiAtCommit: () => '0.9.7' });
    assert.equal(byId(rep, 'ui').level, 'block');
    assert.equal(byId(rep, 'latest').status, 'fail');
    assert.equal(rep.ok, false);
});

test('latest.json：取不到那版 package-lock 时跳过而不是误报', async () => {
    const host = 'www.kaiyuanguji.com';
    const rep = await run(host, fakeSite(host), { uiAtCommit: () => null });
    assert.equal(byId(rep, 'latest').status, 'skip');
});

test('证书：过期是回滚项，快过期是关注项，握手失败算证书失败', async () => {
    const host = 'www.kaiyuanguji.com';
    const site = fakeSite(host);
    const at = (d) => ({ [`https://${host}/`]: { status: 200, body: site.html(), cert: { validTo: new Date(d) } } });
    let rep = await run(host, fakeSite(host, at('2026-09-01')));
    assert.deepEqual([byId(rep, 'cert').level, byId(rep, 'cert').status], ['block', 'fail']);
    rep = await run(host, fakeSite(host, at('2026-10-05')));
    assert.deepEqual([byId(rep, 'cert').level, byId(rep, 'cert').status], ['watch', 'fail']);
    rep = await run(host, fakeSite(host, { [`https://${host}/`]: new Error("Hostname/IP does not match certificate's altnames") }));
    assert.match(byId(rep, 'cert').detail, /握手失败/);
    assert.equal(byId(rep, 'home').status, 'fail');
    assert.equal(byId(rep, 'noindex').status, 'skip');
});

test('演练别的域名：裸域跳转只是关注项；http 不跳 https 是关注项', async () => {
    const host = 'ssr-test.kaiyuanguji.com';
    const rep = await run(host, fakeSite(host, {
        [`http://${host}/`]: { status: 200, body: '<html>' },
        'https://kaiyuanguji.com/': { status: 200, body: '<html>' },
    }));
    assert.equal(byId(rep, 'apex').level, 'watch');
    assert.equal(byId(rep, 'http').level, 'watch');
    assert.equal(rep.ok, true);
});

test('sitemap 分片没指向 www 记关注项', async () => {
    const host = 'ssr-test.kaiyuanguji.com';
    const rep = await run(host, fakeSite(host, {
        [`https://${host}/sitemap-index.xml`]: { status: 200, body: '<sitemapindex><sitemap><loc>https://staging.kaiyuanguji.com/sitemaps/a.xml</loc></sitemap></sitemapindex>' },
    }));
    assert.equal(byId(rep, 'sitemap').status, 'fail');
});

test('parseArgs', () => {
    assert.equal(parseArgs([]).host, 'www.kaiyuanguji.com');
    assert.equal(parseArgs(['https://ssr-test.kaiyuanguji.com/']).host, 'ssr-test.kaiyuanguji.com');
    assert.equal(parseArgs(['--no-apex']).apex, '');
    assert.equal(parseArgs(['--expect-ui', '1.0.0']).expectedUi, '1.0.0');
    assert.throws(() => parseArgs(['--bogus']));
    assert.throws(() => parseArgs(['a b']));
});

test('uiVersionFromLock／metaContent', () => {
    assert.equal(uiVersionFromLock(JSON.stringify({ packages: { 'node_modules/book-index-ui': { version: '0.9.8' } } })), '0.9.8');
    assert.equal(uiVersionFromLock('{}'), null);
    assert.equal(metaContent('<meta name="bim-ui-version" content="1.2.3"/>', 'bim-ui-version'), '1.2.3');
    assert.equal(metaContent('<meta name="x" content="1"/>', 'robots'), null);
});

test('httpGet：不跟跳转，读状态、头、正文', async () => {
    const srv = http.createServer((req, res) => {
        if (req.url === '/r') { res.writeHead(308, { location: '/x' }); res.end(); return; }
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(`ua=${req.headers['user-agent']}`);
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const saved = { HTTPS_PROXY: process.env.HTTPS_PROXY, https_proxy: process.env.https_proxy };
    delete process.env.HTTPS_PROXY; delete process.env.https_proxy;
    try {
        const { port } = srv.address();
        const a = await httpGet(`http://127.0.0.1:${port}/r`);
        assert.equal(a.status, 308);
        assert.equal(a.headers.location, '/x');
        const b = await httpGet(`http://127.0.0.1:${port}/`);
        assert.equal(b.status, 200);
        assert.match(b.body, /kyg-cutover-check/);
        assert.equal(b.cert, null);
    } finally {
        Object.assign(process.env, Object.fromEntries(Object.entries(saved).filter(([, v]) => v !== undefined)));
        srv.close();
    }
});

test('httpGet：Content-Encoding: gzip 的正文解开成明文', async () => {
    const xml = '<?xml version="1.0"?><sitemapindex><sitemap><loc>https://www.kaiyuanguji.com/sitemaps/work-001.xml</loc></sitemap></sitemapindex>';
    const gz = gzipSync(Buffer.from(xml, 'utf8'));
    const srv = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8', 'content-encoding': 'gzip' });
        res.end(gz);
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const saved = { HTTPS_PROXY: process.env.HTTPS_PROXY, https_proxy: process.env.https_proxy };
    delete process.env.HTTPS_PROXY; delete process.env.https_proxy;
    try {
        const { port } = srv.address();
        const r = await httpGet(`http://127.0.0.1:${port}/sitemap-index.xml`);
        assert.equal(r.status, 200);
        assert.equal(r.body, xml);
    } finally {
        Object.assign(process.env, Object.fromEntries(Object.entries(saved).filter(([, v]) => v !== undefined)));
        srv.close();
    }
});

test('httpGet：无 Content-Encoding 的明文正文不变', async () => {
    const xml = '<?xml version="1.0"?><urlset></urlset>';
    const srv = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8' });
        res.end(xml);
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const saved = { HTTPS_PROXY: process.env.HTTPS_PROXY, https_proxy: process.env.https_proxy };
    delete process.env.HTTPS_PROXY; delete process.env.https_proxy;
    try {
        const { port } = srv.address();
        const r = await httpGet(`http://127.0.0.1:${port}/sitemap-index.xml`);
        assert.equal(r.status, 200);
        assert.equal(r.body, xml);
    } finally {
        Object.assign(process.env, Object.fromEntries(Object.entries(saved).filter(([, v]) => v !== undefined)));
        srv.close();
    }
});
