/**
 * 阅读首页 /read（overview#267 第 16 项、#308）的浏览器行为：
 * - 加载后页面不能被滚动、焦点不能落在「跳到正文」上（测试站 3d0ef77 的整页截图里，
 *   这一页的顶栏画在 y≈180 处，压住标题，左上角露出「跳到正文」）；
 * - 分区（book-index-ui ReadHomeView）：分区导航锚点都有对应分区，页面上不出现「整理本」「全文」，
 *   没有可见的大标题与导语，手机上不撑出横向滚动；年代带链到 /read?period=，年代页能翻页。
 *
 * 只发 GET。静态站没有 /read，整组跳过；分区数据（read/sections.json）上线前，分区用例跳过。
 */
import { test, expect } from '../fixtures/test';
import { TARGET } from '../fixtures/anchors';
import { SITE } from '../fixtures/site-profile';
import { requireReadSections } from '../fixtures/preconditions';

test.describe('阅读首页 /read：加载后位置与焦点', () => {
    test.skip(!SITE.fullstack, `${SITE.host} 是静态站，没有 /read`);

    for (const vp of [{ name: '1440', width: 1440, height: 900 }, { name: '390', width: 390, height: 844 }]) {
        test(`${vp.name} 宽：networkidle 后 scrollY 为 0，焦点不在「跳到正文」`, async ({ browser }) => {
            const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
            const page = await ctx.newPage();
            await page.goto(`${TARGET}/read`, { waitUntil: 'load' });
            await page.waitForLoadState('networkidle');
            await page.waitForTimeout(500); // 水合后的延迟动作（focus／scroll）多半在这段时间里发生
            expect(await page.evaluate(() => window.scrollY)).toBe(0);
            const active = await page.evaluate(() => {
                const a = document.activeElement;
                return { tag: a?.tagName, cls: a?.className ?? '', href: a?.getAttribute('href') ?? '' };
            });
            expect(active.cls, 'skip link').not.toContain('og-skip');
            expect(active.href).not.toBe('#main-content');
            // 页首（搜索框，或数据未上线时的「正在准备」）在首屏内：顶栏没有压住它
            const first = await page.locator('[data-read-search], main p').first().boundingBox();
            expect(first && first.y).toBeGreaterThanOrEqual(0);
            expect(first && first.y).toBeLessThan(vp.height);
            const nav = await page.locator('header.og-nav').boundingBox();
            expect(nav && nav.y).toBe(0);
            await ctx.close();
        });
    }

    test('导航「阅读」高亮（aria-current）', async ({ page }) => {
        await page.goto(`${TARGET}/read`, { waitUntil: 'load' });
        const cur = page.locator('header nav[aria-label="主导航"] a[aria-current="page"]');
        await expect(cur).toHaveText('阅读');
        await expect(cur).toHaveAttribute('href', '/read');
    });
});

test.describe('阅读首页 /read：分区（overview#308）', () => {
    test.skip(!SITE.fullstack, `${SITE.host} 是静态站，没有 /read`);
    test.beforeEach(async ({ request }) => { await requireReadSections(request, '阅读首页分区'); });

    test('分区导航锚点都有对应分区；没有可见大标题与导语；不出现「整理本」「全文」', async ({ page }) => {
        await page.goto(`${TARGET}/read`, { waitUntil: 'load' });
        const nav = page.getByRole('navigation', { name: '阅读首页分区' });
        const hrefs = await nav.getByRole('link').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
        expect(hrefs.length).toBeGreaterThan(0);
        for (const h of hrefs) await expect(page.locator(h!)).toHaveCount(1);
        // h1 只给读屏
        const h1 = page.getByRole('heading', { level: 1, name: '阅读' });
        await expect(h1).toHaveCount(1);
        expect((await h1.boundingBox())?.width ?? 0).toBeLessThanOrEqual(1);
        const text = await page.locator('.bim-rh').innerText();
        expect(text).not.toMatch(/整理本|全文/);
        // 史志书架挪去元数据页（overview#322）
        await expect(page.locator('.bim-rh-shelf')).toHaveCount(0);
    });

    test('年代带 → 年代页：200、有卡片、canonical；翻页地址带 page', async ({ page }) => {
        await page.goto(`${TARGET}/read`, { waitUntil: 'load' });
        const band = page.locator('#period a[href^="/read?period="]').first();
        const href = await band.getAttribute('href');
        expect(href).toMatch(/^\/read\?period=[a-z]+$/);
        const res = await page.goto(`${TARGET}${href}`, { waitUntil: 'load' });
        expect(res?.status()).toBe(200);
        await expect(page.locator('[data-read-card]').first()).toBeVisible();
        await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', new RegExp(`${href!.replace(/[?]/g, '\\?')}$`));
        const next = page.locator('a[rel="next"]');
        if (await next.count()) expect(await next.getAttribute('href')).toMatch(/&page=2$/);
    });

    test('手机 390：页面不横向撑宽（推荐卡横滑在自己的容器里）', async ({ browser }) => {
        const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
        const page = await ctx.newPage();
        await page.goto(`${TARGET}/read`, { waitUntil: 'load' });
        const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
        expect(sw).toBeLessThanOrEqual(iw);
        await ctx.close();
    });
});
