/**
 * 主要页面一键截图 + 图集。
 *
 *   TARGET=https://staging.kaiyuanguji.com npm run shots
 *   COMPARE=https://www.kaiyuanguji.com  可选，同一页再截一张对照，图集里并排
 *
 * 输出 e2e/out/shots/<页面名>-<宽度>[-cmp].jpg 与 index.html。
 * 只发 GET，不点任何按钮。单页失败不中断，图集里标红。
 */
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGES } from './pages.ts';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.OUT_DIR ?? join(here, '..', 'out', 'shots');
const TARGET = (process.env.TARGET ?? 'https://staging.kaiyuanguji.com').replace(/\/$/, '');
const COMPARE = process.env.COMPARE ? process.env.COMPARE.replace(/\/$/, '') : '';
const VIEWPORTS = [
    { key: '1440', width: 1440, height: 900 },
    { key: '390', width: 390, height: 844 },
];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** 逐屏滚到底触发懒加载，再回顶 */
async function scrollThrough(page) {
    await page.evaluate(async () => {
        const step = Math.max(300, window.innerHeight * 0.8);
        let y = 0;
        for (let i = 0; i < 60; i++) {
            window.scrollTo(0, y);
            await new Promise((r) => setTimeout(r, 150));
            y += step;
            if (y >= document.documentElement.scrollHeight) break;
        }
        window.scrollTo(0, 0);
    });
}

async function shoot(browser, base, p, vp, file) {
    const ctx = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        reducedMotion: 'reduce',
        isMobile: vp.width < 600,
        deviceScaleFactor: 1,
    });
    const page = await ctx.newPage();
    try {
        const resp = await page.goto(base + p.path, { waitUntil: 'load', timeout: 60_000 });
        await page.addStyleTag({
            content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}',
        });
        await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
        await scrollThrough(page);
        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(500);
        await page.screenshot({ path: file, type: 'jpeg', quality: 70, fullPage: true });
        return { ok: true, status: resp?.status() ?? 0 };
    } catch (e) {
        return { ok: false, error: String(e.message ?? e).split('\n')[0] };
    } finally {
        await ctx.close();
    }
}

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const rows = [];
for (const p of PAGES) {
    const row = { p, cells: {} };
    for (const vp of VIEWPORTS) {
        for (const [tag, base] of [['', TARGET], ...(COMPARE ? [['-cmp', COMPARE]] : [])]) {
            const name = `${p.name}-${vp.key}${tag}.jpg`;
            const r = await shoot(browser, base, p, vp, join(OUT, name));
            row.cells[vp.key + tag] = { name, ...r };
            console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${base}${p.path} @${vp.key} ${r.ok ? r.status : r.error}`);
        }
    }
    rows.push(row);
}
await browser.close();

const cell = (c, label) =>
    !c ? '' : c.ok
        ? `<figure><figcaption>${esc(label)} · HTTP ${c.status}</figcaption><a href="${esc(c.name)}"><img loading="lazy" src="${esc(c.name)}"></a></figure>`
        : `<figure class="bad"><figcaption>${esc(label)} · 失败：${esc(c.error)}</figcaption></figure>`;
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>截图图集</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;margin:16px;background:#fafafa;color:#222}
h1{font-size:18px} h2{font-size:15px;margin:0} .row{display:flex;gap:16px;align-items:flex-start;margin:0 0 32px;padding-top:12px;border-top:2px solid #ccc}
.meta{width:220px;flex:none;position:sticky;top:8px;word-break:break-all;font-size:12px}
.grp{display:flex;gap:12px;align-items:flex-start} figure{margin:0} figcaption{font-size:12px;color:#666}
img{display:block;border:1px solid #ccc;background:#fff} .d img{width:min(720px,55vw)} .m img{width:195px}
.bad{color:#b00;border:1px solid #b00;padding:8px}
</style>
<h1>截图图集 · ${esc(TARGET)}${COMPARE ? ` ⇄ ${esc(COMPARE)}` : ''} · ${new Date().toISOString()}</h1>
${rows.map(({ p, cells }) => `<div class="row"><div class="meta"><h2>${esc(p.title)}</h2><code>${esc(p.name)}</code><br><a href="${esc(TARGET + p.path)}">${esc(p.path)}</a></div>
<div class="grp d">${cell(cells['1440'], '桌面 1440')}${cell(cells['1440-cmp'], '对照 1440')}</div>
<div class="grp m">${cell(cells['390'], '手机 390')}${cell(cells['390-cmp'], '对照 390')}</div></div>`).join('\n')}
</html>`;
await writeFile(join(OUT, 'index.html'), html);
await writeFile(join(OUT, 'manifest.json'), JSON.stringify({ target: TARGET, compare: COMPARE, rows }, null, 1));
const failed = rows.flatMap((r) => Object.values(r.cells)).filter((c) => !c.ok).length;
console.log(`done: ${OUT}/index.html, failed=${failed}`);
