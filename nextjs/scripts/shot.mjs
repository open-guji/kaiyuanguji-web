#!/usr/bin/env node
/**
 * npm run shot -- <路径>… —— 对本地站（默认 http://localhost:3000）截桌面＋手机图，供 PR 描述用。
 *
 *   npm run shot -- /read/96mid1ogzk /item/96kzkdm8e8
 *   TARGET=https://staging.openguji.com npm run shot -- /catalog
 *   OUT_DIR=… 改输出目录；输出到 docs/pr-screenshots/<名>-desktop.png、<名>-mobile.png
 *   FULL=1 整页（默认只截首屏；阅读页整页上万像素，别开）。
 */
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : join(root, 'docs', 'pr-screenshots');
const TARGET = (process.env.TARGET || 'http://localhost:3000').replace(/\/$/, '');
const paths = process.argv.slice(2).filter((a) => a !== '--');
if (!paths.length) { console.error('用法：npm run shot -- /路径 [/路径2 …]'); process.exit(1); }

const VIEWPORTS = [
  { key: 'desktop', width: 1440, height: 900, mobile: false },
  { key: 'mobile', width: 390, height: 844, mobile: true },
];
const nameOf = (p) => (p.replace(/^\/+|\/+$/g, '').replace(/[^A-Za-z0-9]+/g, '-') || 'home').slice(0, 60);

await mkdir(OUT, { recursive: true });
// 浏览器：优先 PW_CHROMIUM；云端会话里 Playwright 自带版本对不上时，回落到预装的 /opt/pw-browsers/chromium
const exe = process.env.PW_CHROMIUM || '';
const fallback = '/opt/pw-browsers/chromium';
let browser;
try { browser = await chromium.launch(exe ? { executablePath: exe } : {}); }
catch (e) {
  if (!exe && existsSync(fallback)) browser = await chromium.launch({ executablePath: fallback, args: ['--no-sandbox'] });
  else throw e;
}
let failed = 0;
for (const p of paths) {
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      isMobile: vp.mobile, hasTouch: vp.mobile, deviceScaleFactor: 2, reducedMotion: 'reduce',
    });
    const page = await ctx.newPage();
    const file = join(OUT, `${nameOf(p)}-${vp.key}.png`);
    try {
      const r = await page.goto(TARGET + p, { waitUntil: 'load', timeout: 120_000 });
      await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}html{scroll-behavior:auto!important}' });
      await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
      await page.screenshot({ path: file, fullPage: !!process.env.FULL });
      console.log(`${r?.status() ?? '?'} ${file}`);
    } catch (e) {
      failed++; console.error(`✗ ${p} (${vp.key}): ${e.message}`);
    }
    await ctx.close();
  }
}
await browser.close();
process.exit(failed ? 1 : 0);
