/**
 * 全文搜索前端（GUJI-163 F6）—— mock 版验收。
 *
 * 不依赖搜索后端：`/api/fulltext` 全部用 page.route 拦成固定响应（形状同 F1 契约样例），
 * 所以搜索索引没上线（GUJI-142）时也能跑。只验前端：全文 tab、结果渲染与转义、点命中跳阅读页、
 * 阅读页 `?ft=` 定位提示、错误/空结果文案。
 *
 * 构建期开关 NEXT_PUBLIC_FULLTEXT_TAB 没开（默认）时，页面上没有「全文」tab，整组自动跳过，
 * 不会让没开开关的站点红。开开关前后各跑一次：关＝全部 skipped，开＝全部应绿。
 */
import { test, expect, type Page } from '../fixtures/test';
import { ANCHORS, TARGET } from '../fixtures/anchors';
import { SITE } from '../fixtures/site-profile';

const C = ANCHORS.collated;
const Q = '王弼輔嗣';

const FT_TAB = (page: Page) => page.getByRole('tab', { name: /全文/ });

function body(over: Record<string, unknown> = {}) {
    return {
        q: Q,
        mode: 'fuzzy',
        normalized: '王弼辅嗣',
        truncated: false,
        total_books: 1,
        total_books_capped: false,
        has_more: false,
        total_hits: 1,
        capped: false,
        groups: [{
            entry: C.id,
            title: '示例書名<img src=x onerror=window.__xss=1>',
            hit_count: 1,
            hits: [{
                chapter: '001',
                label: '卷一',
                passage: [0, 40],
                matches: [[3, 7]],
                snippet: '易類<script>window.__xss=1</script>，<mark>王弼輔嗣</mark>注。',
            }],
        }],
        took_ms: { search: 5, locate: 1, total: 6 },
        ...over,
    };
}

async function mockFulltext(page: Page, status: number, json: unknown, headers: Record<string, string> = {}) {
    await page.route('**/api/fulltext*', (route) =>
        route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(json) }));
}

test.describe('全文搜索前端（mock）', () => {
    test.skip(!SITE.fullstack, `${SITE.host} 是静态站，没有全文搜索`);

    /** 开关没开 ⇒ 没有 tab ⇒ 跳过（不是失败） */
    async function openSearch(page: Page) {
        await page.goto(`${TARGET}/book-index?q=${encodeURIComponent(Q)}`);
        const tab = FT_TAB(page);
        const appeared = await tab.waitFor({ state: 'visible', timeout: 20_000 }).then(() => true, () => false);
        test.skip(!appeared, 'NEXT_PUBLIC_FULLTEXT_TAB 未开（构建期开关），全文 tab 不渲染');
    }

    test('命中按书分组渲染，正文只有 <mark> 生效，标题与片段里的标签被转义', async ({ page }) => {
        await mockFulltext(page, 200, body());
        await openSearch(page);
        const panel = page.getByRole('tabpanel');
        await expect(panel.locator('mark', { hasText: Q })).toBeVisible();
        await expect(panel.getByText('示例書名<img', { exact: false })).toBeVisible();
        expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
        await expect(panel.locator('img[src="x"], script')).toHaveCount(0);
    });

    test('命中链接带 ft/ftq；点进阅读页后地址保留、出现定位提示并可关闭', async ({ page }) => {
        await mockFulltext(page, 200, body());
        await openSearch(page);
        const link = page.getByRole('tabpanel').getByRole('link', { name: '卷一' });
        await expect(link).toHaveAttribute('href', new RegExp(`/read/${C.id}/001\\?ft=001(:|%3A)3-7&ftq=`));
        await link.click();
        await expect(page).toHaveURL(new RegExp(`/read/${C.id}/001\\?.*ft=001(:|%3A)3-7`), { timeout: 30_000 });
        const hint = page.getByRole('status').filter({ hasText: /全文搜索/ });
        await expect(hint).toBeVisible({ timeout: 30_000 });
        await expect(hint).toContainText(Q);
        await hint.getByRole('button', { name: /關閉|关闭/ }).click();
        await expect(hint).toBeHidden();
    });

    test('has_more 时「加载更多」再取一次，偏移为已加载的组数', async ({ page }) => {
        const offsets: string[] = [];
        await page.route('**/api/fulltext*', (route) => {
            const u = new URL(route.request().url());
            offsets.push(u.searchParams.get('offset') ?? '');
            const more = offsets.length === 1;
            route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body({ has_more: more })) });
        });
        await openSearch(page);
        await page.getByRole('button', { name: /加載更多|加载更多/ }).click();
        await expect.poll(() => offsets.length).toBe(2);
        expect(offsets[1]).toBe('1');
    });

    test('无结果显示空状态文案', async ({ page }) => {
        await mockFulltext(page, 200, body({ groups: [], total_hits: 0, total_books: 0 }));
        await openSearch(page);
        await expect(page.getByRole('tabpanel').getByText(/沒有找到包含|没有找到包含/)).toBeVisible();
    });

    for (const [status, re, extra] of [
        [400, /換個關鍵詞|换个关键词/, {}],
        [429, /搜索太頻繁|搜索太频繁/, { 'retry-after': '7' }],
        [503, /暫不可用|暂不可用/, {}],
    ] as const) {
        test(`接口 ${status} 给出对应提示，不白屏`, async ({ page }) => {
            await mockFulltext(page, status, { error: String(status) }, extra);
            await openSearch(page);
            await expect(page.getByRole('tabpanel').getByRole('alert')).toContainText(re);
        });
    }
});
