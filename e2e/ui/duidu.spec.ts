/**
 * 图文对读 /read/96mid1ogzk/original/002（overview#389 A7）：点字高亮书影、滚动翻页、悬停专名出摘要卡并跳条目。
 *
 * 只在全栈站跑；前端须 >= 对读版 book-index-ui。
 * 数据（新结构文本、002.pages.json、002.entity.json）没上线时整组跳过。
 * 书影来自 data.kaiyuanguji.com 的 IIIF（overview#388），页序＝IA leaf 号。
 */
import { test, expect, type Page } from '@playwright/test';
import { TARGET } from '../fixtures/anchors';
import { SITE } from '../fixtures/site-profile';
import { requireNewTextData, requireUiVersion } from '../fixtures/preconditions';

const BOOK = '96mid1ogzk';
const PATH = `${TARGET}/read/${BOOK}/original/002`;
/** 带对读模式的 book-index-ui 版本（bim 对读 PR 发版后填） */
const MIN_UI = '0.44.0';

/** 当前书影页（书影区标牌「第 N 葉」上的 data-warp-page） */
const warpPage = (page: Page) => page.locator('[data-warp-page]').first();

async function openDuidu(page: Page) {
    await page.goto(PATH);
    await expect(page.locator('[data-char-id]').first()).toBeVisible({ timeout: 60_000 });
    // 专名线默认关；对读正文的实体标注跟着它走
    const toggle = page.getByRole('button', { name: /专名线|專名線/ });
    if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
}

test.describe('图文对读', () => {
    test.skip(!SITE.fullstack, `${SITE.host} 是静态站，没有阅读页路由`);
    test.beforeEach(async ({ request }) => {
        await requireUiVersion(request, MIN_UI, '图文对读');
        await requireNewTextData(request, BOOK, '图文对读（新结构文本）');
        const pages = await request.get(`${TARGET}/data/items/${BOOK}/original/002.pages.json`);
        test.skip(!pages.ok(), `${TARGET} 上还没有 ${BOOK} 的对读数据（002.pages.json 为 ${pages.status()}）`);
    });

    test('点字：书影上出现高亮框，书影页＝该字所在页', async ({ page }) => {
        await openDuidu(page);
        const ch = page.locator('[data-char-id^="20:"]').first();
        await ch.scrollIntoViewIfNeeded();
        await ch.click();
        await expect(warpPage(page)).toHaveAttribute('data-warp-page', '20');
        await expect(page.locator('svg rect[data-selected="true"]').first()).toBeVisible();
    });

    test('正文滚到下一页，书影页码跟着变', async ({ page }) => {
        await openDuidu(page);
        const before = Number(await warpPage(page).getAttribute('data-warp-page'));
        const target = page.locator(`[data-char-id^="${before + 3}:"]`).first();
        await target.scrollIntoViewIfNeeded();
        await expect.poll(async () => Number(await warpPage(page).getAttribute('data-warp-page')), { timeout: 15_000 })
            .toBeGreaterThan(before);
    });

    test('书影来自 data.kaiyuanguji.com，不读站内 /facsimiles/', async ({ page }) => {
        const imgs: string[] = [];
        page.on('request', (r) => { if (r.resourceType() === 'image') imgs.push(r.url()); });
        await openDuidu(page);
        await expect.poll(() => imgs.some((u) => u.includes('data.kaiyuanguji.com/iiif/'))).toBe(true);
        expect(imgs.filter((u) => u.includes('/facsimiles/'))).toEqual([]);
    });

    test('悬停已收录的专名出摘要卡；点字只高亮不跳，Ctrl 点击才进条目页', async ({ page }) => {
        await openDuidu(page);
        const link = page.locator('a.bim-et[href^="/item/"]').first();
        await link.scrollIntoViewIfNeeded();
        await link.hover();
        await expect(page.getByRole('tooltip')).toBeVisible();
        const href = await link.getAttribute('href');
        // 点专名里的字：照常点字，留在阅读页
        await link.locator('[data-char-id]').first().click();
        await expect(page).toHaveURL(PATH);
        await expect(warpPage(page)).toBeVisible();
        // Ctrl 点击进条目页
        await link.locator('[data-char-id]').first().click({ modifiers: ['Control'] });
        await expect(page).toHaveURL(new RegExp(`${href}$`), { timeout: 15_000 });
    });
});
