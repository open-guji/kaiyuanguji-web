#!/usr/bin/env node
/**
 * S5 排序对比：同一批查询分别打 Meili 与 search-api（PG），比第 1 名、前 5 名重合度与耗时。
 * 在上海搜索机上跑（两边都是本机）：
 *   MEILI_KEY=… SEARCH_API_KEY=… node compare.mjs --queries q.tsv [--meili http://127.0.0.1:7700] [--pg http://127.0.0.1:7710] [--out diff.tsv]
 * q.tsv 每行 `索引<TAB>查询词`（索引 works|books|entities|collections）；make-queries.sh 从库里抽样生成。
 * 通过线（方案 S5）：works 第 1 名一致率 ≥ 90%；不一致的逐条看（diff.tsv 列出两边前 3 名标题）。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const a = process.argv.slice(2);
const arg = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
const MEILI = arg('--meili', 'http://127.0.0.1:7700').replace(/\/$/, '');
const PG = arg('--pg', 'http://127.0.0.1:7710').replace(/\/$/, '');
const OUT = arg('--out', 'diff.tsv');
const CONC = Number(arg('--conc', 4));
const lines = readFileSync(arg('--queries', 'q.tsv'), 'utf-8').split('\n').filter(Boolean);
const queries = lines.map((l) => { const [index, q] = l.split('\t'); return { index, q }; }).filter((x) => x.index && x.q);
if (!process.env.MEILI_KEY || !process.env.SEARCH_API_KEY) { console.error('需要 MEILI_KEY 与 SEARCH_API_KEY 环境变量'); process.exit(1); }

async function post(url, key, body) {
    const t0 = performance.now();
    const r = await fetch(`${url}/multi-search`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`${url} HTTP ${r.status}`);
    return { json: await r.json(), ms: performance.now() - t0 };
}
const pct = (arr, p) => { const s = [...arr].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0; };
const label = (h) => `${h.title || h.primary_name || ''}(${h.id})`;

const stats = {};
const diffs = [];
let next = 0;
async function worker() {
    while (next < queries.length) {
        const { index, q } = queries[next++];
        try {
            const m = await post(MEILI, process.env.MEILI_KEY, { queries: [{ indexUid: index, q, limit: 5, filter: 'is_draft = false' }] });
            const p = await post(PG, process.env.SEARCH_API_KEY, { queries: [{ indexUid: index, q, limit: 5, offset: 0, filter: [] }] });
            const mh = m.json.results[0].hits, ph = p.json.results[0].hits;
            const s = (stats[index] ??= { n: 0, top1: 0, overlap: 0, denom: 0, bothEmpty: 0, pgEmpty: 0, meiliEmpty: 0, mMs: [], pMs: [], err: 0 });
            s.n++; s.mMs.push(m.ms); s.pMs.push(p.ms);
            if (!mh.length && !ph.length) { s.bothEmpty++; continue; }
            if (!ph.length) s.pgEmpty++;
            if (!mh.length) s.meiliEmpty++;
            const same1 = mh[0] && ph[0] && mh[0].id === ph[0].id;
            if (same1) s.top1++;
            const ids = new Set(ph.map((h) => h.id));
            s.overlap += mh.filter((h) => ids.has(h.id)).length; s.denom += Math.max(mh.length, 1);
            if (!same1) diffs.push([index, q, mh.slice(0, 3).map(label).join(' | '), ph.slice(0, 3).map(label).join(' | ')].join('\t'));
        } catch (e) {
            (stats[index] ??= { n: 0, top1: 0, overlap: 0, denom: 0, bothEmpty: 0, pgEmpty: 0, meiliEmpty: 0, mMs: [], pMs: [], err: 0 }).err++;
            console.error(`${index}\t${q}\t${e.message}`);
        }
    }
}
await Promise.all(Array.from({ length: CONC }, worker));
writeFileSync(OUT, 'index\tq\tmeili_top3\tpg_top3\n' + diffs.join('\n') + '\n');
for (const [idx, s] of Object.entries(stats)) {
    const nonEmpty = s.n - s.bothEmpty;
    console.log(`${idx}: ${s.n} 条（两边都 0 命中 ${s.bothEmpty}，仅 PG 空 ${s.pgEmpty}，仅 Meili 空 ${s.meiliEmpty}，出错 ${s.err}）`
        + `\n  第1名一致 ${(100 * s.top1 / Math.max(nonEmpty, 1)).toFixed(1)}%  前5重合 ${(100 * s.overlap / Math.max(s.denom, 1)).toFixed(1)}%`
        + `\n  Meili p50/p95 ${pct(s.mMs, 0.5).toFixed(0)}/${pct(s.mMs, 0.95).toFixed(0)}ms  PG p50/p95 ${pct(s.pMs, 0.5).toFixed(0)}/${pct(s.pMs, 0.95).toFixed(0)}ms`);
}
console.log(`不一致明细：${OUT}`);
