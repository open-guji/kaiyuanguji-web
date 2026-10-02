#!/usr/bin/env node
/**
 * warm-read-pages.mjs — 部署后预热热门阅读页（overview#322 方案 A）
 *
 * 新部署后云函数实例全是新的，阅读页首次渲染要走 h1 四跳＋正文，超过 EdgeOne 回源时限就回 503
 * （部署刚完那一刻首次失败约 5.5%，overview#322 实测）。读者和 verify 都会撞上。
 * 这里在部署、清缓存之后把热门阅读页先 GET 一遍：实例热起来，ISR 也把这批页写进缓存（1 小时内命中）。
 *
 * 热门＝read/featured.json 全部（整理本、Book 全文）＋ read/tree.json 每个一级节点的第 1 页。
 * 只请求主版本 /read/<id>（不取 manifest，越轻越好）。
 * 结果不计成败：退出码恒为 0（清单都读不了也只打 ::warning::），首次状态分布与 p50／p90／最长耗时写进 job summary。
 * 页面里若有首次渲染计时（web#216 的 <script id="kyg-render-timing">，Server-Timing 语法），顺手解析：
 * 按「本实例第几个请求」分冷热（req≤3 算冷实例），各段 p50／p90 一并写进 summary——部署刚完成时的冷启动实测就从这里来。
 *
 * 只发 GET，无依赖、无 secret。CLI：
 *   node ops/warm-read-pages.mjs --target https://staging.kaiyuanguji.com --data https://data.kaiyuanguji.com/staging [--concurrency 6] [--timeout 60000]
 * 环境变量 TARGET／DATA_BASE 同名。
 */
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { percentile } from './read-links-check.mjs';

/**
 * 列出要预热的阅读页（去重，featured 在前）。清单读不了的记进 errors，不抛。
 * @returns {Promise<{ urls: string[], errors: string[] }>}
 */
export async function listHotPages({ target, dataBase, fetchImpl = fetch }) {
    const cur = `${dataBase.replace(/\/$/, '')}/current`;
    const site = target.replace(/\/$/, '');
    const bust = `t=${Date.now()}`;
    const errors = [];
    async function json(rel) {
        try {
            const res = await fetchImpl(`${cur}/${rel}?${bust}`, { headers: { 'cache-control': 'no-cache' } });
            if (!res.ok) { errors.push(`${rel} → HTTP ${res.status}`); return null; }
            return await res.json();
        } catch (e) {
            errors.push(`${rel} → ${e.message}`);
            return null;
        }
    }
    const ids = [];
    const seen = new Set();
    const add = (c) => { if (c?.id && !seen.has(c.id)) { seen.add(c.id); ids.push(c.id); } };
    const featured = await json('read/featured.json');
    for (const c of featured?.collated ?? []) add(c);
    for (const c of featured?.books ?? []) add(c);
    const tree = await json('read/tree.json');
    for (const node of Array.isArray(tree) ? tree : []) {
        const page = await json(`read/${node.id}/1.json`);
        for (const c of Array.isArray(page) ? page : []) add(c);
    }
    return { urls: ids.map((id) => `${site}/read/${id}`), errors };
}

/** 解析页面里的首次渲染计时；没有或格式不对返回 null */
export function parseRenderTiming(html) {
    const m = typeof html === 'string' ? html.match(/id="kyg-render-timing">"([^<]*)"<\/script>/) : null;
    if (!m) return null;
    const v = m[1].replace(/\\"/g, '"');
    const t = {};
    for (const [, n, d] of v.matchAll(/(\w+);dur=(\d+)/g)) t[n] = Number(d);
    const inst = v.match(/req=(\d+) up=(\d+)s/);
    if (!inst || t.total === undefined) return null;
    t.req = Number(inst[1]);
    t.up = Number(inst[2]);
    return t;
}

/**
 * 低并发 GET 一遍，记首次状态与耗时。不重试（预热只求把实例和缓存热起来，测的就是首次）。
 * @returns {Promise<{ results: { url: string, status: number, ms: number }[] }>}
 */
export async function warmPages(urls, { fetchImpl = fetch, concurrency = 6, timeoutMs = 60_000, now = () => Date.now() } = {}) {
    const results = [];
    const queue = [...urls];
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
            const t0 = now();
            let status = 0;
            let timing = null;
            try {
                const res = await fetchImpl(url, { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(timeoutMs) });
                status = res.status;
                // 读完响应体再算完：提前断开，边缘可能不把这次渲染写进缓存
                const html = res.text ? await res.text().catch(() => '') : (await res.arrayBuffer?.().catch(() => {}), '');
                if (res.ok) timing = parseRenderTiming(html);
            } catch {
                status = 0;
            }
            results.push({ url, status, ms: now() - t0, timing });
        }
    }));
    return { results };
}

export function renderSummary({ results, errors = [] }, { target }) {
    const ms = results.map((r) => r.ms);
    const notOk = results.filter((r) => r.status !== 200);
    const byStatus = {};
    for (const r of results) {
        const k = r.status === 0 ? '连接失败／超时' : String(r.status);
        byStatus[k] = (byStatus[k] ?? 0) + 1;
    }
    const sec = (x) => `${(x / 1000).toFixed(1)} s`;
    const pct = results.length ? ((notOk.length / results.length) * 100).toFixed(1) : '0.0';
    const lines = [
        `## 预热热门阅读页（${target}）`,
        '',
        `${results.length} 页，首次非 200 的 ${notOk.length} 页（${pct}%）；首次耗时 p50 ${sec(percentile(ms, 50))}、p90 ${sec(percentile(ms, 90))}、最长 ${sec(percentile(ms, 100))}。`,
        `首次状态：${Object.entries(byStatus).map(([k, v]) => `${k}×${v}`).join('、') || '—'}（结果不计成败，overview#322）`,
    ];
    const timed = results.filter((r) => r.timing);
    if (timed.length) {
        const row = (label, rs) => {
            if (!rs.length) return `| ${label} | 0 | — | — | — | — |`;
            const cell = (k) => { const v = rs.map((r) => r.timing[k]).filter((x) => x !== undefined); return v.length ? `${percentile(v, 50)} / ${percentile(v, 90)}` : '—'; };
            return `| ${label} | ${rs.length} | ${cell('item')} | ${cell('check')} | ${cell('preload')} | ${cell('total')} |`;
        };
        const cold = timed.filter((r) => r.timing.req <= 3);
        lines.push('', `首次渲染计时（页面里的 kyg-render-timing，${timed.length} 页带计时；毫秒，p50 / p90；冷＝实例第 1–3 个请求）：`, '',
            '| | 页数 | item | check | preload | total |', '|---|---|---|---|---|---|',
            row('冷实例', cold), row('热实例', timed.filter((r) => r.timing.req > 3)), row('全部', timed));
    }
    if (notOk.length) {
        lines.push('', '首次非 200 的页（前 20）：');
        for (const r of notOk.slice(0, 20)) lines.push(`- ${r.url} → ${r.status || '连接失败／超时'}（${sec(r.ms)}）`);
    }
    if (errors.length) {
        lines.push('', '清单读不了（这些节点没有预热）：');
        for (const e of errors.slice(0, 20)) lines.push(`- ${e}`);
    }
    return lines.join('\n');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
    const { parseArgs } = await import('node:util');
    const { values: a } = parseArgs({ options: { target: { type: 'string' }, data: { type: 'string' }, concurrency: { type: 'string' }, timeout: { type: 'string' } } });
    const target = a.target ?? process.env.TARGET;
    const dataBase = a.data ?? process.env.DATA_BASE;
    if (!target || !dataBase) {
        console.log('::warning::预热跳过：缺 --target／TARGET 或 --data／DATA_BASE');
        process.exit(0);
    }
    let md;
    try {
        const t0 = Date.now();
        const { urls, errors } = await listHotPages({ target, dataBase });
        const { results } = await warmPages(urls, { concurrency: a.concurrency ? Number(a.concurrency) : 6, timeoutMs: a.timeout ? Number(a.timeout) : 60_000 });
        md = `${renderSummary({ results, errors }, { target })}\n\n总用时 ${Math.round((Date.now() - t0) / 1000)} s。`;
        if (errors.length) console.log(`::warning title=预热::${errors.length} 份清单读不了，见 job summary`);
    } catch (e) {
        md = `## 预热热门阅读页（${target}）\n\n预热脚本出错（不拦发布）：${e.message}`;
        console.log(`::warning title=预热::${e.message}`);
    }
    console.log(md);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
    process.exit(0);
}
