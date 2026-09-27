#!/usr/bin/env node
/**
 * 新旧架构对比报告（任务书 §六）：汇总最近 N 小时的样本，出 markdown。
 *
 *   node monitor/compare-report.mjs --samples .monitor/perf/samples.jsonl \
 *        [--vitals .monitor-smoke/perf/vitals.jsonl] [--hours 48] [--out report.md]
 *
 * workflow 里每 6 小时（smoke job）自动出一份 24 小时的进 Step Summary，
 * 也可手动 workflow_dispatch suite=compare 指定小时数。
 */
import { writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonl } from './lib/samples.mjs';
import { loadTargets } from './perf-config.mjs';

/** 最近秩法分位数（p ∈ [0,1]），空数组回 null */
export function quantile(values, p) {
  const a = values.filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  const idx = Math.min(a.length - 1, Math.max(0, Math.ceil(p * a.length) - 1));
  return a[idx];
}

// 表里旧站在前、新站在后、共用最后
const ORDER = { old: 0, new: 1, shared: 2 };
const byTarget = (a, b) => (ORDER[a.target] ?? 9) - (ORDER[b.target] ?? 9) || a.target.localeCompare(b.target);
const fmtMs = (v) => (v == null ? '—' : `${Math.round(v)}`);
const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : '—');

function groupBy(rows, keyFn) {
  const m = new Map();
  for (const r of rows) { const k = keyFn(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
  return m;
}

/** HTTP 样本 → 每（目标, 页面类）一行统计 */
export function summarizeHttp(rows) {
  const out = [];
  for (const [k, g] of groupBy(rows.filter((r) => r.kind !== 'check'), (r) => `${r.target}\t${r.kind}`)) {
    const [target, kind] = k.split('\t');
    const ok = g.filter((r) => r.ok);
    const known = g.filter((r) => r.hit != null);
    out.push({
      target, kind, n: g.length, errors: g.length - ok.length,
      ttfbP50: quantile(ok.map((r) => r.ttfb), 0.5), ttfbP95: quantile(ok.map((r) => r.ttfb), 0.95),
      totalP50: quantile(ok.map((r) => r.total), 0.5), totalP95: quantile(ok.map((r) => r.total), 0.95),
      hitRate: known.length ? known.filter((r) => r.hit).length / known.length : null, hitKnown: known.length,
      statuses: [...new Set(g.filter((r) => !r.ok).map((r) => r.status))],
    });
  }
  return out.sort((a, b) => a.kind.localeCompare(b.kind) || byTarget(a, b));
}

/** 影子检查 → 每（目标, 检查项）的通过率与最近一次失败原因 */
export function summarizeChecks(rows) {
  const out = [];
  for (const [k, g] of groupBy(rows.filter((r) => r.kind === 'check'), (r) => `${r.target}\t${r.id}`)) {
    const [target, id] = k.split('\t');
    const fails = g.filter((r) => !r.ok);
    out.push({ target, id, n: g.length, fails: fails.length, last: fails.at(-1)?.failed?.slice(0, 2).join('；') || '' });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id) || byTarget(a, b));
}

/** 浏览器样本 → 每（目标, 页面）LCP／TTI／TBT 的 p50／p95 */
export function summarizeVitals(rows) {
  const out = [];
  // 按页面类（首页／条目页）分组：旧站条目页是 /book-index?id=、新站是 /item/，路径不同但要并排比
  for (const [k, g] of groupBy(rows, (r) => `${r.target}\t${r.kind || r.page}`)) {
    const [target, page] = k.split('\t');
    const ok = g.filter((r) => r.ok);
    const q = (f, p) => quantile(ok.map((r) => r[f]), p);
    out.push({
      target, page, n: g.length, errors: g.length - ok.length,
      lcpP50: q('lcp', 0.5), lcpP95: q('lcp', 0.95), ttiP50: q('tti', 0.5), ttiP95: q('tti', 0.95),
      tbtP50: q('tbt', 0.5), fcpP50: q('fcp', 0.5),
    });
  }
  return out.sort((a, b) => a.page.localeCompare(b.page) || byTarget(a, b));
}

export function renderReport({ samples, vitals, hours, now = Date.now(), targets = loadTargets() }) {
  const cutoff = now - hours * 3600000;
  const inWin = (r) => Date.parse(r.t) >= cutoff;
  const s = samples.filter(inWin);
  const v = vitals.filter(inWin);
  const label = Object.fromEntries([...targets.map((t) => [t.name, t.label]), ['shared', '共用（两边都直连）']]);
  const L = (n) => label[n] || n;
  const runs = new Set(s.filter((r) => r.kind !== 'check').map((r) => r.t)).size;

  const lines = [
    `## 新旧架构对比（最近 ${hours} 小时，截至 ${new Date(now).toISOString().slice(0, 16)}Z）`,
    '',
    `HTTP 采样 ${runs} 轮、${s.filter((r) => r.kind !== 'check').length} 条；浏览器采样 ${v.length} 条。` +
      `目标：${targets.map((t) => `${t.label} ${t.base}`).join('；')}。`,
    '',
    '### 一、HTTP（文档本身；毫秒，只算成功的请求）',
    '',
    '> 旧站 HTML 是静态壳、不含条目内容，浏览器还要再去数据桶取；新站 `/item` 是服务端直出。所以这一节只比「文档多快到」，用户多快看到内容看第三节 LCP。',
    '',
    '| 页面类 | 目标 | 样本 | 错误率 | 首字节 p50 | 首字节 p95 | 总耗时 p50 | 总耗时 p95 | CDN 命中 |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  const http = summarizeHttp(s);
  for (const r of http) {
    const err = r.errors ? `${pct(r.errors, r.n)}（${r.statuses.join('/')}）` : '0%';
    lines.push(`| ${r.kind} | ${L(r.target)} | ${r.n} | ${err} | ${fmtMs(r.ttfbP50)} | ${fmtMs(r.ttfbP95)} | ${fmtMs(r.totalP50)} | ${fmtMs(r.totalP95)} | ${r.hitRate == null ? '看不出' : pct(r.hitRate * r.hitKnown, r.hitKnown)} |`);
  }

  // 同类页面新/旧 p50 之比，一眼看出快慢
  const byKind = groupBy(http, (r) => r.kind);
  const ratios = [];
  for (const [kind, g] of byKind) {
    const o = g.find((r) => r.target === 'old');
    const n = g.find((r) => r.target === 'new');
    if (o?.totalP50 && n?.totalP50) ratios.push(`${kind}：新/旧 总耗时 p50 = ${(n.totalP50 / o.totalP50).toFixed(2)}，p95 = ${n.totalP95 && o.totalP95 ? (n.totalP95 / o.totalP95).toFixed(2) : '—'}`);
  }
  if (ratios.length) lines.push('', ...ratios.map((x) => `- ${x}`));

  lines.push('', '### 二、可用性（新站跑同一组 A 类检查，只记录不告警）', '');
  const checks = summarizeChecks(s);
  if (!checks.length) lines.push('（窗口内无检查样本）');
  else {
    lines.push('| 检查项 | 目标 | 次数 | 失败 | 失败率 | 最近一次失败 |', '|---|---|---|---|---|---|');
    for (const c of checks) lines.push(`| ${c.id} | ${L(c.target)} | ${c.n} | ${c.fails} | ${pct(c.fails, c.n)} | ${c.last.replace(/\|/g, '\\|')} |`);
  }

  lines.push('', '### 三、浏览器指标（Playwright Chromium，每 6 小时；毫秒）', '');
  const vit = summarizeVitals(v);
  if (!vit.length) lines.push('（窗口内无浏览器样本）');
  else {
    lines.push('| 页面 | 目标 | 样本 | 失败 | LCP p50 | LCP p95 | 可交互 p50 | 可交互 p95 | TBT p50 | FCP p50 |', '|---|---|---|---|---|---|---|---|---|---|');
    for (const r of vit) lines.push(`| ${r.page} | ${L(r.target)} | ${r.n} | ${r.errors} | ${fmtMs(r.lcpP50)} | ${fmtMs(r.lcpP95)} | ${fmtMs(r.ttiP50)} | ${fmtMs(r.ttiP95)} | ${fmtMs(r.tbtP50)} | ${fmtMs(r.fcpP50)} |`);
  }
  lines.push('', '说明：p95 在样本少于 20 时等于接近最大值，参考价值有限；跑满 24～48 小时再下结论。');
  return lines.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const hours = Number(get('--hours', 48));
  const samples = readJsonl(get('--samples', '.monitor/perf/samples.jsonl'));
  const vitals = readJsonl(get('--vitals', '.monitor-smoke/perf/vitals.jsonl'));
  const md = renderReport({ samples, vitals, hours });
  console.log(md);
  const out = get('--out', null);
  if (out) writeFileSync(out, md + '\n');
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
