/**
 * 花园明朝扩展区字兜底（overview#421）：字体不放我们的 COS，直接用公共 CDN 上 npm 包 hanamin@0.0.5 的分片
 * （jsDelivr，备 unpkg）。CSS 带 unicode-range：只在页面里出现了系统字体没有的扩展区字时才下载对应的那几片，
 * 普通页面一个字节也不下。
 *
 * CDN 取不到（公网抖动、被墙）时整组跳过，不拦发版——这类用例红了不等于线上回归。
 * 读到的是 vol03（含 𠮓、𫎇 等扩展 B 字；简体显示还有繁简转出来的 𪩘、𫄥、𫐖，在扩展 C、D）。
 */
import { test, expect, type Page } from '../fixtures/test';
import { TARGET } from '../fixtures/anchors';
import { SITE } from '../fixtures/site-profile';
import { requireNewTextData, requireTextFile } from '../fixtures/preconditions';

const BOOK = '96mid1ogzk';
const CDN_PROBE = 'https://cdn.jsdelivr.net/npm/hanamin@0.0.5/HanaMinB.CJK-Unified-Ideographs-Extension-B-01.woff2';
/** 只许是扩展 A、B–F、兼容表意文字（及补充）这几类分片，不许整包（拉丁、常用汉字…）被引进来 */
const EXT_CHUNK = /\/hanamin@0\.0\.5\/HanaMin[AB]\.(CJK-Unified-Ideographs-Extension-[A-F](-\d+)?|CJK-Compatibility-Ideographs(-Supplement)?)\.woff2$/;

/** 记下页面发出的花园明朝字体请求（URL） */
function watchHanamin(page: Page): string[] {
    const urls: string[] = [];
    page.on('request', (r) => { if (/\/hanamin@[^/]+\/[^/]+\.woff2$/.test(r.url())) urls.push(r.url()); });
    return urls;
}

test.describe('花园明朝兜底字体（公共 CDN）', () => {
    test.skip(!SITE.fullstack, `${SITE.host} 是静态站，没有阅读页路由`);
    test.beforeEach(async ({ request }) => {
        const res = await request.head(CDN_PROBE).catch(() => null);
        test.skip(!res?.ok(), `CDN（${CDN_PROBE}）取不到：${res ? res.status() : '网络错'}，整组跳过`);
    });

    test('普通页面（首页）不下载这套字体', async ({ page }) => {
        const urls = watchHanamin(page);
        await page.goto(TARGET);
        await page.waitForLoadState('networkidle');
        expect(urls).toEqual([]);
    });

    test('页面里全是常用字：不下载；出现系统字体没有的扩展 B 字才下载含它的那一片', async ({ page }) => {
        const urls = watchHanamin(page);
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
        // U+20000 是扩展 B 的第一个字：只拉 Extension-B-01 这一片，不会把别的分片都拉下来
        await addText('t-ext', '\u{20000}');
        await expect.poll(() => urls.length, { timeout: 20_000 }).toBeGreaterThan(0);
        expect(urls.every((u) => u.includes('/hanamin@0.0.5/HanaMinB.CJK-Unified-Ideographs-Extension-B-01.woff2'))).toBe(true);
    });

    test('vol03 对读页：只请求扩展区分片；繁体生僻字与简体转出的扩展区字都可见', async ({ page, request }) => {
        await requireNewTextData(request, BOOK, '花园明朝（vol03）');
        await requireTextFile(request, BOOK, 'original/003.cord.json', '花园明朝（vol03）');
        const urls = watchHanamin(page);
        await page.goto(`${TARGET}/read/${BOOK}/original/003`);
        // 第 109 页「六十四卦，𠮓某卦自某卦而来」：𠮓（扩展 B）后面的字不能被带成空白
        const ch = page.locator('[data-char-id="109:7:19"]');
        await ch.scrollIntoViewIfNeeded();
        await expect(ch).toBeVisible({ timeout: 60_000 });
        await expect.poll(() => urls.length, { timeout: 30_000 }).toBeGreaterThan(0);
        // 请求的全是扩展区分片，一个都不许是拉丁、常用汉字等其它区块
        for (const u of urls) expect(u, u).toMatch(EXT_CHUNK);
        const loaded = await page.evaluate(async () => {
            await document.fonts.ready;
            return [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/"/g, ''));
        });
        expect(loaded).toContain('HanaMinB');
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
