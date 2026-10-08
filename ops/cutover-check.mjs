#!/usr/bin/env node
// CUT（overview#141）：切站验收——域名从旧静态项目 kaiyuanguji 换绑到全栈项目 kyg-ssr-spike 之后，
// 5 分钟内跑这一条，看成没成、要不要回滚。
//
//   node ops/cutover-check.mjs                            # 默认查 www.kaiyuanguji.com
//   node ops/cutover-check.mjs ssr-test.kaiyuanguji.com   # 演练
//   node ops/cutover-check.mjs --json                     # 机读
//
// 全程只读：只发 GET（跳转一律不跟），不带任何凭证，不碰 EdgeOne 配置。
// 零依赖（Node ≥ 20）。有 HTTPS_PROXY 时自己走 CONNECT 隧道（本地／云端会话里要），
// 这样证书也是真站的证书；GitHub Actions 里直连。
//
// 每一项分两档：
//   回滚项  失败 = ❌，退出码 1，切站当晚看到就回滚（docs/cutover.md）
//   关注项  失败 = ⚠️，不影响退出码，记下来第二天处理
// 退出码：0 = 回滚项全过；1 = 有回滚项失败；2 = 参数错误。

import http from 'node:http';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { resolveCodeCommit } from './code-pointer.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_HOST = 'www.kaiyuanguji.com';
export const DEFAULT_APEX = 'kaiyuanguji.com';
export const DEFAULT_DATA_BASE = 'https://data.kaiyuanguji.com';

/**
 * 条目页锚点：都已升格到 production，同 e2e/fixtures/anchors.ts（work／collated／entity 三类各一）。
 * 旧静态站上 /item/<id> 是 404，全栈项目才 200——这三项同时也在验「域名确实换到了新项目」。
 */
export const ITEMS = [
    { id: 'd59f20aowb9c', title: '史記' },
    { id: 'd59f2htm01du', title: '直齋書錄解題' },
    { id: 'hixhd2h9bk4b', title: '孔子' },
];

/** 证书剩余天数低于此值记关注项 */
export const CERT_WARN_DAYS = 14;

const TIMEOUT_MS = 15_000;
const MAX_BODY = 4 * 1024 * 1024;

// ---------------------------------------------------------------- 网络层

function proxyUrl(host) {
    const p = process.env.HTTPS_PROXY || process.env.https_proxy;
    if (!p) return null;
    const no = (process.env.NO_PROXY || process.env.no_proxy || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (no.some((n) => n === '*' || host === n.replace(/^\./, '') || host.endsWith(n.startsWith('.') ? n : `.${n}`))) return null;
    return new URL(p);
}

function connectSocket(host, port, timeoutMs) {
    const proxy = proxyUrl(host);
    if (!proxy) return Promise.resolve(null); // 直连：交给 tls.connect／http.request 自己连
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: proxy.hostname,
            port: proxy.port || 80,
            method: 'CONNECT',
            path: `${host}:${port}`,
            headers: { host: `${host}:${port}` },
            timeout: timeoutMs,
        });
        req.on('connect', (res, socket) => {
            if (res.statusCode === 200) resolve(socket);
            else {
                socket.destroy();
                reject(new Error(`代理 CONNECT ${host}:${port} 返回 ${res.statusCode}`));
            }
        });
        req.on('timeout', () => req.destroy(new Error('代理连接超时')));
        req.on('error', reject);
        req.end();
    });
}

/**
 * GET 一个 URL，不跟跳转。返回 { status, headers, body, cert }；
 * cert 只在 https 时有：{ validTo: Date, subject, altNames }。
 */
export async function httpGet(url, { headers = {}, timeoutMs = TIMEOUT_MS } = {}) {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const port = Number(u.port) || (isHttps ? 443 : 80);
    const raw = await connectSocket(u.hostname, port, timeoutMs);

    let sock = raw;
    if (isHttps) {
        sock = await new Promise((resolve, reject) => {
            const s = tls.connect({
                ...(raw ? { socket: raw } : { host: u.hostname, port }),
                servername: u.hostname,
                ALPNProtocols: ['http/1.1'],
            });
            s.setTimeout(timeoutMs, () => s.destroy(new Error('TLS 握手超时')));
            s.once('secureConnect', () => { s.setTimeout(0); resolve(s); });
            s.once('error', reject);
        });
    }
    let cert = null;
    if (isHttps) {
        const c = sock.getPeerCertificate();
        cert = { validTo: new Date(c.valid_to), subject: c.subject?.CN ?? '', altNames: c.subjectaltname ?? '' };
    }

    return new Promise((resolve, reject) => {
        const req = http.request({
            host: u.hostname,
            port,
            method: 'GET',
            path: u.pathname + u.search,
            headers: { 'user-agent': 'kyg-cutover-check/1', accept: '*/*', connection: 'close', ...headers },
            ...(sock ? { createConnection: () => sock } : {}),
            timeout: timeoutMs,
        }, (res) => {
            const chunks = [];
            let size = 0;
            res.on('data', (d) => {
                size += d.length;
                if (size <= MAX_BODY) chunks.push(d);
            });
            res.on('end', () => resolve({
                status: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks).toString('utf8'),
                cert,
            }));
            res.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error(`请求超时（${timeoutMs / 1000}s）`)));
        req.on('error', reject);
        req.end();
    });
}

/** 网络错误重试一次（HTTP 状态码不重试：切站后看到的就是用户看到的） */
async function getWithRetry(get, url, opts) {
    try {
        return await get(url, opts);
    } catch {
        await new Promise((r) => setTimeout(r, 1000));
        return get(url, opts);
    }
}

// ---------------------------------------------------------------- 期望值

/** 从 package-lock.json 文本里取实际解析到的 book-index-ui 版本（页面 meta 注入的就是它） */
export function uiVersionFromLock(lockText) {
    const lock = JSON.parse(lockText);
    return lock.packages?.['node_modules/book-index-ui']?.version ?? null;
}

/** main（即当前 checkout）的 book-index-ui 版本 */
function mainUiVersion() {
    return uiVersionFromLock(readFileSync(path.join(REPO_ROOT, 'nextjs/package-lock.json'), 'utf8'));
}

/** 某个网站代码 commit 的 book-index-ui 版本；取不到（浅克隆、未知 commit）返回 null */
function uiVersionAtCommit(sha) {
    if (!/^[0-9a-f]{7,40}$/.test(sha)) return null;
    try {
        const text = execFileSync('git', ['-C', REPO_ROOT, 'show', `${sha}:nextjs/package-lock.json`], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024,
        });
        return uiVersionFromLock(text);
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------- 检查

export function metaContent(html, name) {
    const re = new RegExp(`<meta\\s+name="${name}"\\s+content="([^"]*)"`, 'i');
    return html.match(re)?.[1] ?? null;
}

/**
 * 读 robots.txt 的三个信号（去掉行尾 # 注释、不分大小写）：
 *   disallowAll    有 `Disallow: /`
 *   allowRoot      有 `Allow: /`
 *   emptyDisallow  有值为空的 `Disallow:`——按标准等于全部允许
 */
export function robotsVerdict(text) {
    const lines = String(text ?? '').split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim());
    return {
        disallowAll: lines.some((l) => /^disallow\s*:\s*\/$/i.test(l)),
        allowRoot: lines.some((l) => /^allow\s*:\s*\/$/i.test(l)),
        emptyDisallow: lines.some((l) => /^disallow\s*:$/i.test(l)),
    };
}

function isRedirect(status) {
    return [301, 302, 303, 307, 308].includes(status);
}

function short(s, n = 80) {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n)}…` : t;
}

/**
 * 跑全部检查。网络与期望值都可注入（测试用假的）。
 * 返回 { host, startedAt, results: [{ id, name, level, status, detail }], ok }
 *   level:  'block'（回滚项）| 'watch'（关注项）
 *   status: 'pass' | 'fail' | 'skip'
 */
export async function runCutoverCheck({
    host = DEFAULT_HOST,
    apex = DEFAULT_APEX,
    dataBase = DEFAULT_DATA_BASE,
    get = httpGet,
    expectedUi = undefined,
    uiAtCommit = uiVersionAtCommit,
    now = () => new Date(),
} = {}) {
    const base = `https://${host}`;
    const results = [];
    const add = (id, name, level, status, detail) => results.push({ id, name, level, status, detail });
    const fetchSafe = async (url, opts) => {
        try {
            return { res: await getWithRetry(get, url, opts) };
        } catch (e) {
            return { err: e instanceof Error ? e.message : String(e) };
        }
    };

    if (expectedUi === undefined) {
        try { expectedUi = mainUiVersion(); } catch { expectedUi = null; }
    }

    // 首页：一次请求，查五项
    const home = await fetchSafe(`${base}/`);
    const html = home.res?.body ?? '';
    const homeOk = home.res?.status === 200;
    add('home', '首页 200', 'block', homeOk ? 'pass' : 'fail',
        home.err ?? `HTTP ${home.res.status}${isRedirect(home.res.status) ? ` → ${home.res.headers.location}` : ''}`);

    const pageUi = homeOk ? metaContent(html, 'bim-ui-version') : null;
    let releasedUi; // latest.json.webCommitId 那版代码的 UI 版本，下面 latest 项算出来后回填到 ui 项
    const uiIdx = results.length;
    add('ui', 'bim-ui-version 与 main 一致', 'block', 'skip', '');

    if (!homeOk) {
        add('noindex', '没有 noindex', 'block', 'skip', '首页没取到');
        add('badge', '没有测试站角标', 'block', 'skip', '首页没取到');
    } else {
        const metaRobots = metaContent(html, 'robots') ?? '';
        const xRobots = String(home.res.headers['x-robots-tag'] ?? '');
        const noindex = /noindex/i.test(metaRobots) || /noindex/i.test(xRobots);
        add('noindex', '没有 noindex', 'block', noindex ? 'fail' : 'pass',
            noindex ? `meta robots="${metaRobots}" X-Robots-Tag="${xRobots}"——这是测试站构建` : '无 meta robots noindex、无 X-Robots-Tag');
        const badge = /data-testid="staging-badge"/.test(html);
        add('badge', '没有测试站角标', 'block', badge ? 'fail' : 'pass',
            badge ? '页面带 staging-badge——这是测试站构建' : '无 staging-badge');
    }

    const robots = await fetchSafe(`${base}/robots.txt`);
    if (robots.err || robots.res.status !== 200) {
        add('robots', 'robots.txt 允许收录', 'block', 'fail', robots.err ?? `HTTP ${robots.res.status}`);
    } else {
        const { disallowAll, allowRoot, emptyDisallow } = robotsVerdict(robots.res.body);
        const allowed = allowRoot || emptyDisallow;
        const how = allowRoot ? 'Allow: /' : '空的 Disallow:';
        add('robots', 'robots.txt 允许收录', 'block', !disallowAll && allowed ? 'pass' : 'fail',
            disallowAll ? '有 Disallow: /（测试站口径）' : allowed ? `${how}${/sitemap:/i.test(robots.res.body) ? '，带 Sitemap' : ''}` : `没有 Allow: / 或空的 Disallow:：${short(robots.res.body)}`);
    }

    // 条目页
    for (const it of ITEMS) {
        const r = await fetchSafe(`${base}/item/${it.id}`);
        let status = 'fail';
        let detail;
        if (r.err) detail = r.err;
        else if (r.res.status !== 200) detail = `HTTP ${r.res.status}${r.res.status === 404 ? '（旧静态站就是 404：域名可能还在旧项目上）' : ''}`;
        else {
            const title = r.res.body.match(/<title>([^<]*)<\/title>/i)?.[1] ?? '';
            if (title.includes(it.title)) { status = 'pass'; detail = `<title>${short(title, 40)}`; }
            else detail = `200 但 <title> 不含「${it.title}」：${short(title, 40)}`;
        }
        add(`item:${it.id}`, `/item/${it.id} 带「${it.title}」`, 'block', status, detail);
    }

    // /book-index?id= → 308 /item/<id>（中间件只改写站外整页导航，按浏览器地址栏直接打开的样子发）
    {
        const id = ITEMS[0].id;
        const r = await fetchSafe(`${base}/book-index?id=${id}`, { headers: { 'sec-fetch-dest': 'document' } });
        let status = 'fail';
        let detail;
        if (r.err) detail = r.err;
        else {
            const loc = r.res.headers.location ?? '';
            let path = '';
            try { path = new URL(loc, base).pathname; } catch { /* 空 */ }
            if (r.res.status === 308 && path === `/item/${id}`) { status = 'pass'; detail = `308 → ${loc}`; }
            else detail = `HTTP ${r.res.status}${loc ? ` → ${loc}` : ''}（期望 308 → /item/${id}）`;
        }
        add('book-index', '/book-index?id= 308 跳转', 'block', status, detail);
    }

    // 边缘函数
    {
        const r = await fetchSafe(`${base}/api/feedback`);
        let ok = false;
        let detail = r.err ?? `HTTP ${r.res.status}`;
        if (!r.err && r.res.status === 200) {
            try { ok = JSON.parse(r.res.body).success === true; detail = ok ? '200，success=true' : `200 但 ${short(r.res.body)}`; }
            catch { detail = `200 但不是 JSON：${short(r.res.body)}`; }
        }
        add('feedback', '/api/feedback 200', 'block', ok ? 'pass' : 'fail', detail);
    }
    {
        const r = await fetchSafe(`${base}/api/auth/me`);
        let status = 'fail';
        let detail = r.err ?? `HTTP ${r.res.status}`;
        if (!r.err) {
            if (r.res.status === 401) { status = 'pass'; detail = '401（未登录，配置已带上）'; }
            else if (r.res.status === 503) detail = `503：控制台环境变量没带进边缘函数（${short(r.res.body, 60)}）`;
            else detail = `HTTP ${r.res.status}（期望 401）：${short(r.res.body, 60)}`;
        }
        add('auth-me', '/api/auth/me 401', 'block', status, detail);
    }
    {
        const r = await fetchSafe(`${base}/api/version`);
        if (r.err) add('api-version', '/api/version', 'watch', 'fail', r.err);
        else if (r.res.status === 404) add('api-version', '/api/version', 'watch', 'skip', '404，本版没有此接口');
        else if (r.res.status === 200 && /json/i.test(String(r.res.headers['content-type']))) add('api-version', '/api/version', 'watch', 'pass', `200：${short(r.res.body, 60)}`);
        else add('api-version', '/api/version', 'watch', 'fail', `HTTP ${r.res.status}：${short(r.res.body, 60)}`);
    }

    // sitemap
    {
        const r = await fetchSafe(`${base}/sitemap-index.xml`);
        let ok = false;
        let detail = r.err ?? `HTTP ${r.res.status}`;
        if (!r.err && r.res.status === 200) {
            const n = (r.res.body.match(/<sitemap>/g) ?? []).length;
            const hosts = [...new Set([...r.res.body.matchAll(/<loc>https?:\/\/([^/<]+)/g)].map((m) => m[1]))];
            ok = /<sitemapindex/.test(r.res.body) && n > 0;
            detail = ok ? `${n} 个分片，指向 ${hosts.join('、')}` : `200 但不是 sitemap 索引：${short(r.res.body)}`;
            if (ok && hosts.some((h) => h !== DEFAULT_HOST)) { ok = false; detail += `（应全指向 ${DEFAULT_HOST}）`; }
        }
        add('sitemap', 'sitemap-index.xml 可取', 'watch', ok ? 'pass' : 'fail', detail);
    }

    // latest.json：数据指针可取；指针记下的网站代码版本（webCommitId）的 UI 版本与页面一致
    {
        const r = await fetchSafe(`${dataBase}/latest.json?_=${now().getTime()}`);
        let status = 'fail';
        let detail = r.err ?? `HTTP ${r.res.status}`;
        if (!r.err && r.res.status === 200) {
            let j = null;
            try { j = JSON.parse(r.res.body); } catch { detail = `不是 JSON：${short(r.res.body)}`; }
            if (j && !j.commitId) detail = '缺 commitId';
            else if (j) {
                // 线上是哪一版代码：latest.json 标了 codePointer 就以 web.json 为准，否则以 latest.json.webCommitId 为准（ops/code-pointer.mjs）
                let webDoc = null;
                const rw = await fetchSafe(`${dataBase}/web.json?_=${now().getTime()}`);
                if (!rw.err && rw.res.status === 200) { try { webDoc = JSON.parse(rw.res.body); } catch { webDoc = null; } }
                const rc = resolveCodeCommit(j, webDoc);
                const web = rc.commit;
                releasedUi = web ? uiAtCommit(web) : null;
                const head = `数据 ${j.commitId}，代码 ${web ? web.slice(0, 12) : '（无 webCommitId）'}（${rc.source}）${rc.notes.length ? `；${rc.notes.join('；')}` : ''}`;
                if (!web) { status = 'fail'; detail = `${head}：正式站还没 promote 过`; }
                else if (releasedUi == null) { status = 'skip'; detail = `${head}：本地取不到该 commit 的 package-lock（浅克隆？），没比 UI 版本`; }
                else if (pageUi == null) { status = 'skip'; detail = `${head}：页面没取到 bim-ui-version`; }
                else if (releasedUi === pageUi) { status = 'pass'; detail = `${head}，UI ${releasedUi} 与页面一致`; }
                else { status = 'fail'; detail = `${head}，该版 UI ${releasedUi} ≠ 页面 ${pageUi}：新项目跑的不是 promote 的那版代码`; }
            }
        }
        add('latest', 'latest.json 与页面版本一致', 'watch', status, detail);
    }

    // 回填 UI 版本项：与 main 一致 → ✅；不一致但与 promote 那版一致（main 刚升 UI 还没上正式站）→ ⚠️；都不一致 → ❌
    {
        const row = results[uiIdx];
        if (!homeOk) Object.assign(row, { status: 'skip', detail: '首页没取到' });
        else if (!pageUi) Object.assign(row, { status: 'fail', detail: '页面没有 bim-ui-version meta' });
        else if (!expectedUi) Object.assign(row, { status: 'skip', detail: `页面 ${pageUi}；读不到 main 的 package-lock` });
        else if (pageUi === expectedUi) Object.assign(row, { status: 'pass', detail: `${pageUi}` });
        else if (releasedUi && pageUi === releasedUi) Object.assign(row, { level: 'watch', status: 'fail', detail: `页面 ${pageUi} ≠ main ${expectedUi}，但与 promote 的那版一致（main 的新 UI 还没上正式站）` });
        else Object.assign(row, { status: 'fail', detail: `页面 ${pageUi} ≠ main ${expectedUi}` });
    }

    // 证书（用首页那次握手拿到的）
    {
        if (home.err) {
            const certErr = /certificate|CERT_|self.signed|altname|expired/i.test(home.err);
            add('cert', '证书有效', 'block', 'fail', certErr ? `握手失败：${home.err}` : `没连上：${home.err}`);
        } else if (!home.res.cert) {
            add('cert', '证书有效', 'block', 'skip', '没拿到证书信息');
        } else {
            const days = Math.floor((home.res.cert.validTo.getTime() - now().getTime()) / 86_400_000);
            const until = home.res.cert.validTo.toISOString().slice(0, 10);
            if (days < 0) add('cert', '证书有效', 'block', 'fail', `已于 ${until} 过期`);
            else if (days < CERT_WARN_DAYS) add('cert', '证书有效', 'watch', 'fail', `${days} 天后（${until}）过期，尽快续`);
            else add('cert', '证书有效', 'block', 'pass', `到 ${until}，剩 ${days} 天`);
        }
    }

    // http → https
    {
        const r = await fetchSafe(`http://${host}/`);
        let ok = false;
        let detail = r.err ?? `HTTP ${r.res.status}`;
        if (!r.err) {
            const loc = r.res.headers.location ?? '';
            ok = isRedirect(r.res.status) && loc.startsWith(`https://${host}`);
            detail = isRedirect(r.res.status) ? `${r.res.status} → ${loc}` : `HTTP ${r.res.status}，没跳 https`;
        }
        add('http', 'http → https 跳转', 'watch', ok ? 'pass' : 'fail', detail);
    }

    // 裸域 → www：只有目标是 www 时才是回滚项；演练别的域名时只看现状
    if (apex) {
        const r = await fetchSafe(`https://${apex}/`);
        let ok = false;
        let detail = r.err ?? `HTTP ${r.res.status}`;
        if (!r.err) {
            const loc = r.res.headers.location ?? '';
            ok = isRedirect(r.res.status) && loc.startsWith(`https://${DEFAULT_HOST}`);
            detail = isRedirect(r.res.status) ? `${r.res.status} → ${loc}` : `HTTP ${r.res.status}，没跳到 www`;
        }
        add('apex', `${apex} → www 跳转`, host === DEFAULT_HOST ? 'block' : 'watch', ok ? 'pass' : 'fail', detail);
    }

    const ok = results.every((r) => !(r.level === 'block' && r.status === 'fail'));
    return { host, startedAt: now().toISOString(), results, ok };
}

// ---------------------------------------------------------------- 输出

export function icon(r) {
    if (r.status === 'pass') return '✅';
    if (r.status === 'skip') return '⏭️';
    return r.level === 'block' ? '❌' : '⚠️';
}

export function renderMarkdown(report) {
    const out = [];
    out.push(`### 切站检查：${report.host}`);
    out.push('');
    out.push(`${report.startedAt}（UTC）`);
    out.push('');
    out.push('| | 检查 | 档 | 详情 |');
    out.push('|---|---|---|---|');
    for (const r of report.results) {
        out.push(`| ${icon(r)} | ${r.name} | ${r.level === 'block' ? '回滚项' : '关注项'} | ${String(r.detail).replace(/\|/g, '\\|')} |`);
    }
    out.push('');
    const blocking = report.results.filter((r) => r.level === 'block' && r.status === 'fail');
    const watching = report.results.filter((r) => r.level === 'watch' && r.status === 'fail');
    if (blocking.length) {
        out.push(`**结论：❌ ${blocking.length} 个回滚项失败，按 docs/cutover.md 回滚**——${blocking.map((r) => r.name).join('；')}`);
    } else {
        out.push(`**结论：✅ 回滚项全过，切站成功**${watching.length ? `（${watching.length} 个关注项：${watching.map((r) => r.name).join('；')}）` : ''}`);
    }
    return out.join('\n');
}

// ---------------------------------------------------------------- CLI

export function parseArgs(argv) {
    const opts = { host: DEFAULT_HOST, apex: DEFAULT_APEX, dataBase: DEFAULT_DATA_BASE, json: false };
    const rest = [...argv];
    while (rest.length) {
        const a = rest.shift();
        if (a === '--json') opts.json = true;
        else if (a === '--apex') opts.apex = rest.shift() ?? '';
        else if (a === '--no-apex') opts.apex = '';
        else if (a === '--data-base') opts.dataBase = rest.shift();
        else if (a === '--expect-ui') opts.expectedUi = rest.shift();
        else if (a === '-h' || a === '--help') opts.help = true;
        else if (a.startsWith('-')) throw new Error(`未知参数 ${a}`);
        else opts.host = a;
    }
    opts.host = opts.host.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!/^[a-z0-9.-]+$/i.test(opts.host)) throw new Error(`域名不合法：${opts.host}`);
    return opts;
}

async function main() {
    let opts;
    try {
        opts = parseArgs(process.argv.slice(2));
    } catch (e) {
        console.error(e.message);
        process.exit(2);
    }
    if (opts.help) {
        console.log('用法：node ops/cutover-check.mjs [域名，默认 www.kaiyuanguji.com] [--json] [--apex 裸域|--no-apex] [--expect-ui 版本] [--data-base URL]');
        return;
    }
    const report = await runCutoverCheck(opts);
    console.log(opts.json ? JSON.stringify(report, null, 2) : renderMarkdown(report));
    process.exitCode = report.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main();
}
