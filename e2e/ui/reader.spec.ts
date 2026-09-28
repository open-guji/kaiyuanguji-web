/**
 * 阅读页 /item/<id>/read（N5b）：旧入口跳过来、卷号与地址双向同步、翻卷不整页刷新。
 *
 * 只在全栈站跑（静态站没有这条路由）；前端须 >= 0.10.0（新阅读器）。
 * 地址约定见 nextjs/src/lib/reader-route.ts。
 */
import { test, expect } from '@playwright/test';
import { ANCHORS, TARGET } from '../fixtures/anchors';
import { SITE } from '../fixtures/site-profile';
import { requireUiVersion } from '../fixtures/preconditions';

const C = ANCHORS.collated;

test.describe('阅读页', () => {
    test.skip(!SITE.fullstack, `${SITE.host} 是静态站，没有阅读页路由`);
    test.beforeEach(({ request }) => requireUiVersion(request, '0.10.0', '新阅读器 ReaderShell'));

    test('旧入口保留卷号跳到阅读页，正文渲染出来', async ({ page }) => {
        await page.goto(`${TARGET}/book-index?id=${C.id}&tab=collated&juan=${encodeURIComponent(C.sampleJuanFile)}`);
        await expect(page).toHaveURL(new RegExp(`/item/${C.id}/read\\?kind=collated&juan=${encodeURIComponent(C.sampleJuanFile)}$`));
        await expect(page.getByText(/加载整理本|加載整理本/)).toBeHidden({ timeout: 30_000 });
        await expect(page.getByRole('heading', { name: new RegExp(`${C.sampleJuanCategory}|${C.sampleJuanCategorySimplified}`) }))
            .toBeVisible({ timeout: 30_000 });
    });

    test('不带 juan 进来自动选首卷并写回地址；翻卷改地址与标题、不整页刷新', async ({ page }) => {
        await page.goto(`${TARGET}/item/${C.id}/read?kind=collated`);
        await expect(page).toHaveURL(/[?&]juan=juan%2F001\.json/, { timeout: 30_000 });

        await page.evaluate(() => { (window as unknown as { __n5b: number }).__n5b = 1; });
        await page.getByRole('button', { name: /^卷\s*2$/ }).first().click({ timeout: 30_000 });
        await expect(page).toHaveURL(/[?&]juan=juan%2F002\.json/);
        await expect(page).toHaveTitle(/卷2 · 整理本/);
        expect(await page.evaluate(() => (window as unknown as { __n5b?: number }).__n5b), '翻卷触发了整页刷新').toBe(1);
    });
});
