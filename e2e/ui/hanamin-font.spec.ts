/**
 * 花园明朝扩展区字兜底（overview#421，ops/fonts/）：只在页面里出现了系统字体没有的扩展区字时才下载，
 * 普通页面一个字节也不下；我们自己的书只下几 KB 的「实际用到的字」小子集，不下全量分片。
 *
 * 字体文件在 COS（https://data.kaiyuanguji.com/fonts/hanamin/），还没传上去时整组跳过（先传、后部署）。
 * 读到的是 vol03（含 𠮓、𫎇 等扩展 B 字，简体显示还有繁简转出来的 𪩘、𫄥）。
 */
import { test, expect, type Page } from '@playwright/test';
import { TARGET } from '../fixtures/anchors';
import { SITE } from '../fixtures/site-profile';
import { requireNewTextData, requireTextFile } from '../fixtures/preconditions';

const FONT_BASE = 'https://data.kaiyuanguji.com/fonts/hanamin';
const BOOK = '96mid1ogzk';

/** 记下页面发出的花园明朝请求（文件名） */
function watchHanamin(page: Page): string[] {
    const names: string[] = [];
    page.on('request', (r) => { if (r.url().startsWith(FONT_BASE + '/') && r.url().endsWith('.woff2')) names.push(r.url().slice(FONT_BASE.length + 1)); });
    return names;
}

test.describe('花园明朝兜底字体', () => {
    test.skip(!SITE.fullstack, `${SITE.host} 是静态站，没有阅读页路由`);
    test.beforeEach(async ({ request }) => {
        const lic = await request.head(`${FONT_BASE}/LICENSE.txt`);
        test.skip(!lic.ok(), `${FONT_BASE}/LICENSE.txt 为 ${lic.status()}：字体还没传上 COS，上传后自动生效`);
    });

    test('授权文件随字体放在 COS 上', async ({ request }) => {
        for (const f of ['LICENSE.txt', 'THANKS.txt']) {
            const res = await request.get(`${FONT_BASE}/${f}`);
            expect(res.ok(), f).toBe(true);
        }
        expect(await (await request.get(`${FONT_BASE}/LICENSE.txt`)).text()).toContain('Hanazono');
    });

    test('普通页面（首页）不下载这套字体', async ({ page }) => {
        const names = watchHanamin(page);
        await page.goto(TARGET);
        await page.waitForLoadState('networkidle');
        expect(names).toEqual([]);
    });

    test('页面里全是常用字：不下载；出现系统字体没有的扩展区字才下载对应的那一片', async ({ page }) => {
        const names = watchHanamin(page);
        await page.goto(TARGET);
        const addText = (id: string, text: string) => page.evaluate(([i, t]) => {
            const d = document.createElement('div');
            d.id = i; d.textContent = t;
            d.style.cssText = 'font-family: var(--font-serif); font-size: 30px; position: fixed; top: 120px; left: 20px; z-index: 99999';
            document.body.appendChild(d);
        }, [id, text]);
        await addText('t-common', '欽定四庫全書總目');
        await page.waitForTimeout(1500);
        expect(names).toEqual([]);
        // U+20000（扩展 B 第一个字）不在「实际用到的字」里：只会拉含它的全量分片，不会把别的分片都拉下来
        await addText('t-ext', '\u{20000}');
        await expect.poll(() => names.length, { timeout: 15_000 }).toBeGreaterThan(0);
        expect(names.every((n) => /^HanaMin[AB]\.\d{3}\.r\d+\.woff2$/.test(n))).toBe(true);
        expect(names.length).toBeLessThanOrEqual(2);
    });

    test('vol03 对读页：生僻字可见，只下「实际用到的字」小子集、不下全量分片', async ({ page, request }) => {
        await requireNewTextData(request, BOOK, '花园明朝（vol03）');
        await requireTextFile(request, BOOK, 'original/003.cord.json', '花园明朝（vol03）');
        const names = watchHanamin(page);
        await page.goto(`${TARGET}/read/${BOOK}/original/003`);
        // 第 109 页「六十四卦，𠮓某卦自某卦而来」：𠮓 后面的字不能被带成空白
        const ch = page.locator('[data-char-id="109:7:19"]');
        await ch.scrollIntoViewIfNeeded();
        await expect(ch).toBeVisible({ timeout: 60_000 });
        await expect.poll(() => names.length, { timeout: 20_000 }).toBeGreaterThan(0);
        expect(names.every((n) => /^HanaMin[AB]\.used\.[0-9a-f]{8}\.r\d+\.woff2$/.test(n)), names.join()).toBe(true);
        const loaded = await page.evaluate(async () => {
            await document.fonts.ready;
            return [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/"/g, ''));
        });
        expect(loaded).toContain('HanaMinB');
        // 「𠮓」与它后面的「某」「卦」都有正常字宽（空白字形带坏整串时宽度只有 0.8em）
        const widths = await page.evaluate(() => ['109:7:20', '109:7:21', '109:8:3', '109:8:5'].map((id) => document.querySelector(`[data-char-id="${id}"]`)!.getBoundingClientRect().width));
        for (const w of widths) expect(w).toBeGreaterThan(18);
    });
});
