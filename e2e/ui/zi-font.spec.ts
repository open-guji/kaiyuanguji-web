/**
 * 扩展区生僻字兜底（GUJI-721 第 2 步，原 overview#421 的花园明朝）：Jigmo 2025.9.12 按码位切的约 320 块放在本站数据域名
 * （font/jigmo-<版本>-<哈希>/<首字码位>.woff2），@font-face 在 zi-fonts.css，字族 KygZi 排在字体栈最前。
 * CSS 带 unicode-range：只在页面里出现扩展区字时才下载含它的那一块，普通页面一个字节也不下。
 *
 * 分片取不到（线上还是旧版、数据域名抖动）时整组跳过，不拦发版——这类用例红了不等于线上回归。
 * 读到的是 vol03（含 𠮓、𫎇 等扩展 B 字；简体显示还有繁简转出来的 𪩘、𫄥、𫐖，在扩展 C、D）。
 * 每章打包时会生成本章的生僻字子集（<章>.font.woff2，GUJI-701／721），页面先从子集取，子集里有的字就不再请求分片：
 * 阅读页上「分片」与「子集」哪种请求都算数，字形可见才是要守的。
 */
import { test, expect, type Page } from '../fixtures/test';
import { TARGET } from '../fixtures/anchors';
import { SITE } from '../fixtures/site-profile';
import { requireNewTextData, requireTextFile } from '../fixtures/preconditions';

const BOOK = '96mid1ogzk';
const ZI_CHUNK = /\/font\/jigmo-\d{8}-[0-9a-f]{10}\/[0-9a-f]{4,5}\.woff2$/;

/** 记下页面发出的分片请求（URL） */
function watchZi(page: Page): string[] {
    const urls: string[] = [];
    page.on('request', (r) => { if (ZI_CHUNK.test(r.url())) urls.push(r.url()); });
    return urls;
}

/** 页面 CSS 里 KygZi 各块的地址，按 unicode-range 起点索引（取不到 CSSOM 的跨域表不算） */
function ziFaces(page: Page): Promise<Record<string, string>> {
    return page.evaluate(() => {
        const out: Record<string, string> = {};
        for (const sheet of [...document.styleSheets]) {
            let rules: CSSRuleList;
            try { rules = sheet.cssRules; } catch { continue; }
            for (const r of [...rules]) {
                if (!(r instanceof CSSFontFaceRule) || !/KygZi/.test(r.style.getPropertyValue('font-family'))) continue;
                const url = /url\("?([^")]+)"?\)/.exec(r.style.getPropertyValue('src'))?.[1];
                const start = /^U\+([0-9A-F]+)/i.exec(r.style.getPropertyValue('unicode-range'))?.[1];
                if (url && start) out[start.toUpperCase()] = url;
            }
        }
        return out;
    });
}

test.describe('扩展区兜底字体（本站数据域名）', () => {
    test.skip(!SITE.fullstack, `${SITE.host} 是静态站，没有阅读页路由`);
    test.beforeEach(async ({ page, request }) => {
        await page.goto(TARGET);
        const probe = (await ziFaces(page))['20000'];
        test.skip(!probe, '页面 CSS 里没有 KygZi 分片（线上还是旧版），整组跳过');
        const res = await request.head(probe!).catch(() => null);
        test.skip(!res?.ok(), `分片（${probe}）取不到：${res ? res.status() : '网络错'}，整组跳过`);
    });

    test('普通页面（首页）不下载这套字体', async ({ page }) => {
        const urls = watchZi(page);
        await page.goto(TARGET);
        await page.waitForLoadState('networkidle');
        expect(urls).toEqual([]);
    });

    test('页面里全是常用字：不下载；出现扩展 B 字才下载含它的那一块', async ({ page }) => {
        const urls = watchZi(page);
        await page.goto(TARGET);
        const addText = (id: string, text: string) => page.evaluate(([i, t]) => {
            const d = document.createElement('div');
            d.id = i; d.textContent = t;
            d.style.cssText = 'font-family: var(--font-serif); font-size: 30px; position: fixed; top: 120px; left: 20px; z-index: 99999';
            document.body.appendChild(d);
        }, [id, text]);
        await addText('t-common', '欽定四庫全書總目');
        await page.waitForTimeout(1500);
        expect(urls).toEqual([]);
        // U+20000 是扩展 B 的第一个字：只拉 20000.woff2 这一块，不会把别的块都拉下来
        await addText('t-ext', '\u{20000}');
        await expect.poll(() => urls.length, { timeout: 20_000 }).toBeGreaterThan(0);
        expect(urls.every((u) => u.endsWith('/20000.woff2'))).toBe(true);
    });

    test('vol03 对读页：繁体生僻字与简体转出的扩展区字都可见', async ({ page, request }) => {
        await requireNewTextData(request, BOOK, '扩展区字体（vol03）');
        await requireTextFile(request, BOOK, 'original/003.cord.json', '扩展区字体（vol03）');
        const urls = watchZi(page);
        const subset: string[] = [];
        page.on('request', (r) => { if (/\/items\/96mid1ogzk\/[^/]+\/003\.font\.woff2(\?|$)/.test(r.url())) subset.push(r.url()); });
        await page.goto(`${TARGET}/read/${BOOK}/original/003`);
        // 第 109 页「六十四卦，𠮓某卦自某卦而来」：𠮓（扩展 B）后面的字不能被带成空白
        const ch = page.locator('[data-char-id="109:7:19"]');
        await ch.scrollIntoViewIfNeeded();
        await expect(ch).toBeVisible({ timeout: 60_000 });
        await expect.poll(() => urls.length + subset.length, { timeout: 30_000 }).toBeGreaterThan(0);
        const loaded = await page.evaluate(async () => {
            await document.fonts.ready;
            return [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/"/g, ''));
        });
        expect(loaded).toContain('KygZi');
        // 「𠮓」与它后面的「某」「卦」都有正常字宽（空白字形带坏整串时宽度只有 0.8em）
        const widths = await page.evaluate(() => ['109:7:20', '109:7:21', '109:8:3', '109:8:5'].map((id) => document.querySelector(`[data-char-id="${id}"]`)!.getBoundingClientRect().width));
        for (const w of widths) expect(w).toBeGreaterThan(18);
        // 简体显示下繁简转出来的扩展区字（巘→𪩘 在第 15 页，扩展 C）也有字形，不是空白
        const p15 = page.locator('[data-char-id="15:7:15"]');
        await p15.scrollIntoViewIfNeeded();
        await expect(p15).toHaveText('𪩘');
        await expect.poll(() => page.evaluate(() => document.querySelector('[data-char-id="15:7:15"]')!.getBoundingClientRect().width), { timeout: 20_000 }).toBeGreaterThan(18);
    });
});
