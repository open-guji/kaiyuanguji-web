#!/usr/bin/env node
/**
 * 浏览器指标（任务书 §六）：Playwright Chromium 在新旧两站各测首页和 3 个条目页的
 * LCP、可交互时间（TTI 近似）、TBT、FCP。每页一个新的浏览器上下文（冷缓存），
 * 串行测，避免两站互相抢带宽。结果追加进 JSONL，给 compare-report 用。
 *
 *   node monitor/browser-vitals.mjs --out .monitor-smoke/perf/vitals.jsonl [--repeat 1]
 *
 * Playwright 从 e2e/node_modules 里取（monitor 本身零依赖），先在 e2e 里 npm ci 并装 chromium。
 *
 * TTI 近似：页面 load 且网络静默后再等 5 秒，取「DOMContentLoaded 结束」与「最后一个长任务结束」的较大者
 * ——与 Lighthouse 的定义同思路（主线程最后一次被长任务堵住之后才算可交互），不如它精确，但两边口径一致。
 */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTargets } from './perf-config.mjs';
import { appendJsonl } from './lib/samples.mjs';

const HERE = resolve(fileURLToPath(import.meta.url), '..');

// 页面一开始就挂观察器：longtask 不回放历史，晚挂就漏
export const INIT_SCRIPT = `
  window.__mon = { lcp: 0, longtasks: [] };
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__mon.lcp = Math.max(window.__mon.lcp, e.renderTime || e.startTime); })
      .observe({ type: 'largest-contentful-paint', buffered: true });
  } catch (e) {}
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__mon.longtasks.push([e.startTime, e.duration]); })
      .observe({ type: 'longtask', buffered: true });
  } catch (e) {}
`;

/** 在页面里算指标（传给 page.evaluate） */
export function collectInPage() {
  const nav = performance.getEntriesByType('navigation')[0] || {};
  const fcp = (performance.getEntriesByName('first-contentful-paint')[0] || {}).startTime || null;
  const lts = (window.__mon && window.__mon.longtasks) || [];
  const lastLong = lts.reduce((m, [s, d]) => Math.max(m, s + d), 0);
  const dcl = nav.domContentLoadedEventEnd || 0;
  const tbt = lts.reduce((sum, [s, d]) => sum + (fcp != null && s >= fcp ? Math.max(0, d - 50) : 0), 0);
  const r = (v) => (v ? Math.round(v) : null);
  return {
    ttfb: r(nav.responseStart),
    fcp: r(fcp),
    lcp: r(window.__mon && window.__mon.lcp),
    dcl: r(dcl),
    load: r(nav.loadEventEnd),
    tti: r(Math.max(dcl, lastLong)),
    tbt: Math.round(tbt),
    longtasks: lts.length,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const get = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const out = get('--out', '.monitor-smoke/perf/vitals.jsonl');
  const repeat = Number(get('--repeat', 1));
  const require = createRequire(resolve(HERE, '../e2e/package.json'));
  const { chromium } = require('@playwright/test');

  // 本地若 Playwright 版本与已装浏览器对不上，可用 MON_CHROMIUM_PATH 指一个现成的 Chromium
  const browser = await chromium.launch(process.env.MON_CHROMIUM_PATH ? { executablePath: process.env.MON_CHROMIUM_PATH } : {});
  const rows = [];
  const t = new Date().toISOString();
  try {
    for (let r = 0; r < repeat; r += 1) {
      for (const tg of loadTargets()) {
        for (const page of tg.vitals) {
          const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, userAgent: undefined });
          const p = await ctx.newPage();
          await p.addInitScript(INIT_SCRIPT);
          const row = { t, target: tg.name, kind: page === '/' ? '首页' : '条目页', page: page.replace(/[?&]id=.*|\/item\/.*/, (m) => (m.startsWith('/item') ? '/item/{id}' : '?id={id}')), url: tg.base + page };
          try {
            const res = await p.goto(tg.base + page, { waitUntil: 'load', timeout: 60000 });
            await p.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
            await p.waitForTimeout(5000);
            Object.assign(row, { status: res?.status() ?? 0, ok: !!res && res.status() < 400 }, await p.evaluate(collectInPage));
            // 条目页按 id 区分冷热：记下 id 方便单看
            row.id = (page.match(/(?:id=|\/item\/)([0-9a-z]+)/) || [])[1] || null;
          } catch (e) {
            Object.assign(row, { ok: false, status: 0, error: String(e.message || e).split('\n')[0] });
          }
          await ctx.close();
          rows.push(row);
          console.log(`${row.ok ? '✅' : '❌'} ${tg.name} ${page} LCP=${row.lcp ?? '—'} TTI=${row.tti ?? '—'} TBT=${row.tbt ?? '—'}${row.error ? ` ${row.error}` : ''}`);
        }
      }
    }
  } finally {
    await browser.close();
  }
  const kept = appendJsonl(out, rows);
  console.log(`追加 ${rows.length} 条，文件内共 ${kept} 条（保留 72 小时）`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
