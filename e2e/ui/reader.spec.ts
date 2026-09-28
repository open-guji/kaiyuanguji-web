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

/**
 * 直齋卷一、卷二的正文锚点（档位 3：经典原文，不随整理变）。繁简两种写法都认。
 * 分类标题＋该卷首条书目解题里的一句——只锚地址写回了 juan 不够，正文得真是这一卷。
 */
const JUAN_TEXT = {
    'juan/001.json': { category: /易類|易类/, text: /王弼輔嗣|王弼辅嗣/ },
    'juan/002.json': { category: /書類|书类/, text: /孔安國傳|孔安国传/ },
} as const;

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
        // 地址写回了卷一，正文也得是卷一：分类标题与解题原文都在
        const main = page.getByRole('main');
        const j1 = JUAN_TEXT['juan/001.json'];
        const j2 = JUAN_TEXT['juan/002.json'];
        await expect(main.getByRole('heading', { name: j1.category }), '正文不是卷一（分类标题不对）').toBeVisible({ timeout: 30_000 });
        await expect(main.getByText(j1.text).first(), '卷一正文没有渲染出实际文字').toBeVisible();

        await page.evaluate(() => { (window as unknown as { __n5b: number }).__n5b = 1; });
        await page.getByRole('button', { name: /^卷\s*2$/ }).first().click({ timeout: 30_000 });
        await expect(page).toHaveURL(/[?&]juan=juan%2F002\.json/);
        await expect(page).toHaveTitle(/卷2 · 整理本/);
        // 翻到卷二后正文跟着换：卷二的文字出现，卷一的不再显示
        await expect(main.getByRole('heading', { name: j2.category }), '翻卷后正文不是卷二').toBeVisible({ timeout: 30_000 });
        await expect(main.getByText(j2.text).first(), '卷二正文没有渲染出实际文字').toBeVisible();
        await expect(main.getByText(j1.text), '翻卷后还显示着卷一的正文').toHaveCount(0);
        expect(await page.evaluate(() => (window as unknown as { __n5b?: number }).__n5b), '翻卷触发了整页刷新').toBe(1);
    });
});
