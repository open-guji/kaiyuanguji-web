/**
 * 阅读首页 /read（overview#267 第 16 项）的浏览器行为：
 * 加载后页面不能被滚动、焦点不能落在「跳到正文」上（测试站 3d0ef77 的整页截图里，
 * 这一页的顶栏画在 y≈180 处，压住标题，左上角露出「跳到正文」）。
 *
 * 只发 GET。静态站没有 /read，整组跳过。
 */
import { test, expect } from '@playwright/test';
import { TARGET } from '../fixtures/anchors';
import { SITE } from '../fixtures/site-profile';

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
            // 标题在首屏内：顶栏没有压住它
            const h1 = await page.getByRole('heading', { level: 1, name: '阅读' }).boundingBox();
            expect(h1 && h1.y).toBeGreaterThanOrEqual(0);
            expect(h1 && h1.y).toBeLessThan(vp.height);
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
