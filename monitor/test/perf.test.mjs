// 新旧架构对比（任务书 §六）：采样、影子检查只记录不告警、报告的分位数与表格
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.mjs';
import { samplePerf, shadowChecks, cacheHit, expandPages, measure } from '../checks/perf.mjs';
import { quantile, summarizeHttp, renderReport } from '../compare-report.mjs';
import { appendJsonl, readJsonl } from '../lib/samples.mjs';
import { emptyState } from '../lib/state.mjs';
import { buildContext } from '../run.mjs';
import { loadTargets, COMPARE_IDS } from '../perf-config.mjs';
import { startFake } from './fake.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
let fake;
before(async () => { fake = await startFake(); });
after(async () => { await fake.close(); });

test('默认目标：旧站 www 告警、新站 ssr-test 不告警；条目页 10 个 id', () => {
  const [o, n] = loadTargets({});
  assert.equal(o.base, 'https://www.kaiyuanguji.com');
  assert.equal(n.base, 'https://ssr-test.kaiyuanguji.com');
  assert.equal(o.alert, true);
  assert.equal(n.alert, false);
  assert.equal(COMPARE_IDS.length, 10);
  const pages = expandPages(n);
  assert.equal(pages.filter((p) => p.kind === 'item:ssr').length, 10);
  assert.equal(pages.filter((p) => p.kind === 'home').length, 1);
  assert.equal(expandPages(o).some((p) => p.kind === 'item:ssr'), false, '静态站没有 /item');
});

test('CDN 命中判定', () => {
  assert.equal(cacheHit({ 'eo-cache-status': 'HIT' }), true);
  assert.equal(cacheHit({ 'x-cache': 'MISS from edge' }), false);
  assert.equal(cacheHit({ age: '120' }), true);
  assert.equal(cacheHit({}), null);
});

test('measure：首字节 ≤ 总耗时；连不上记 status 0', async () => {
  const m = await measure(`${fake.base}/www/`);
  assert.equal(m.status, 200);
  assert.ok(m.ttfb <= m.total);
  const bad = await measure('http://127.0.0.1:1/', { timeoutMs: 2000 });
  assert.equal(bad.status, 0);
  assert.equal(bad.ok, false);
});

test('采样：两个目标＋共用搜索，新站挂了照样记样本；影子检查只进样本不碰 GitHub', async () => {
  const cfg = { ...loadConfig(), api: `${fake.base}/api`, timeoutMs: 3000 };
  const targets = [
    { name: 'old', label: '旧', base: `${fake.base}/www`, alert: true, pages: { home: '/', 'item:book-index': '/book-index?id={id}' } },
    { name: 'new', label: '新', base: `${fake.base}/nope`, alert: false, pages: { home: '/', 'item:ssr': '/item/{id}' } },
  ];
  const now = Date.now();
  const s = await samplePerf({ cfg, targets, now });
  assert.equal(s.filter((r) => r.target === 'old').length, 11);
  assert.equal(s.filter((r) => r.target === 'new').length, 11);
  assert.ok(s.filter((r) => r.target === 'old').every((r) => r.ok));
  assert.ok(s.filter((r) => r.target === 'new').every((r) => !r.ok && r.status === 404));
  assert.equal(s.filter((r) => r.target === 'shared' && r.kind === 'search' && r.ok).length, 1);

  const ctx = buildContext({ cfg, now, repoRoot: ROOT, state: emptyState(), tlsConnect: fake.tlsConnect });
  const before = fake.gh.calls.length;
  const checks = await shadowChecks({ cfg, target: targets[1], ctx });
  assert.deepEqual(checks.map((c) => c.id).sort(), ['A1-home', 'A4-item-pages', 'A5-edge', 'A7-tls']);
  assert.ok(checks.find((c) => c.id === 'A1-home').ok === false);
  assert.ok(checks.every((c) => c.kind === 'check' && c.target === 'new'));
  assert.equal(fake.gh.calls.length, before, '影子检查不许碰 GitHub');
});

test('样本文件：追加、按 72 小时裁剪、半行容错', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'mon-')), 'p', 's.jsonl');
  const now = Date.parse('2026-09-28T00:00:00Z');
  appendJsonl(f, [{ t: '2026-09-24T00:00:00Z', a: 1 }, { t: '2026-09-27T12:00:00Z', a: 2 }], { now });
  assert.deepEqual(readJsonl(f).map((r) => r.a), [2]);
  appendJsonl(f, [{ t: '2026-09-27T23:00:00Z', a: 3 }], { now });
  assert.deepEqual(readJsonl(f).map((r) => r.a), [2, 3]);
});

test('分位数与汇总', () => {
  assert.equal(quantile([], 0.5), null);
  assert.equal(quantile([5, 1, 3], 0.5), 3);
  assert.equal(quantile(Array.from({ length: 100 }, (_, i) => i + 1), 0.95), 95);
  const rows = [
    ...Array.from({ length: 20 }, (_, i) => ({ t: 'x', target: 'old', kind: 'home', ok: true, ttfb: 100 + i, total: 200 + i, hit: true })),
    { t: 'x', target: 'old', kind: 'home', ok: false, status: 502, ttfb: null, total: 30000, hit: null },
  ];
  const [h] = summarizeHttp(rows);
  assert.equal(h.n, 21);
  assert.equal(h.errors, 1);
  assert.equal(h.ttfbP50, 109);
  assert.equal(h.totalP95, 218);
  assert.equal(h.hitRate, 1);
  assert.deepEqual(h.statuses, [502]);
});

test('报告：窗口外样本不算；有新/旧比值；三节齐全', () => {
  const now = Date.parse('2026-09-29T00:00:00Z');
  const at = (h) => new Date(now - h * 3600000).toISOString();
  const samples = [
    { t: at(1), target: 'old', kind: 'item:book-index', ok: true, ttfb: 100, total: 200, hit: true },
    { t: at(1), target: 'new', kind: 'item:book-index', ok: true, ttfb: 300, total: 400, hit: false },
    { t: at(100), target: 'new', kind: 'item:book-index', ok: true, ttfb: 9999, total: 9999, hit: false },
    { t: at(1), target: 'new', kind: 'check', id: 'A5-edge', ok: false, failed: ['GET /api/feedback：HTTP 500'] },
  ];
  const vitals = [
    { t: at(2), target: 'old', kind: '首页', page: '/', ok: true, lcp: 1800, tti: 2500, tbt: 120, fcp: 900 },
    { t: at(2), target: 'new', kind: '首页', page: '/', ok: true, lcp: 1200, tti: 2000, tbt: 80, fcp: 700 },
    { t: at(2), target: 'old', kind: '条目页', page: '/book-index?id={id}', ok: true, lcp: 3000, tti: 3500, tbt: 300, fcp: 900 },
    { t: at(2), target: 'new', kind: '条目页', page: '/item/{id}', ok: true, lcp: 900, tti: 1500, tbt: 50, fcp: 600 },
  ];
  const md = renderReport({ samples, vitals, hours: 48, now });
  assert.match(md, /item:book-index：新\/旧 总耗时 p50 = 2\.00/);
  assert.doesNotMatch(md, /9999/);
  assert.match(md, /A5-edge \| 新·全栈/);
  assert.match(md, /GET \/api\/feedback：HTTP 500/);
  assert.match(md, /\| 首页 \| 旧·静态（www） \| 1 \| 0 \| 1800 /);
  assert.match(md, /\| 条目页 \| 旧·静态（www） \| 1 \| 0 \| 3000 [^\n]*\n\| 条目页 \| 新·全栈（ssr-test） \| 1 \| 0 \| 900 /, '新旧条目页并排');
});

test('新站挂死：连续 2 次连不上就跳过余下页面，不拖垮整轮', async () => {
  const cfg = { ...loadConfig(), api: `${fake.base}/api`, timeoutMs: 3000 };
  const targets = [{ name: 'new', label: '新', base: 'http://127.0.0.1:1', alert: false, pages: { home: '/', 'item:ssr': '/item/{id}' } }];
  let calls = 0;
  const measureFn = async (url, o) => { if (url.startsWith('http://127.0.0.1:1')) calls += 1; return measure(url, o); };
  const s = await samplePerf({ cfg, targets, now: Date.now(), measureFn });
  assert.equal(calls, 2);
  assert.equal(s.filter((r) => r.target === 'new' && r.skipped).length, 9);
});
