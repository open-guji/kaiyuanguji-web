/**
 * 站内搜索 —— 繁简互通 + L1/L2 降级。
 *
 * 搜索是两层架构，L1(Meili) 挂了会静默降级到 L2(worker 分片)。这里只断言
 * "用户能搜到东西"，不区分走的哪层——分层健康由 contract/search-backend
 * 负责。这样即便 L1 故障，只要降级正常工作，UI 用例仍应通过。
 */
import { test, expect } from '@playwright/test';
import { SEARCH_QUERIES, TARGET } from '../fixtures/anchors';

test.describe('搜索', () => {
    for (const { q, label } of SEARCH_QUERIES) {
        test(`${label}「${q}」能返回结果`, async ({ page }) => {
            await page.goto(`${TARGET}/book-index?q=${encodeURIComponent(q)}`);

            // 搜索走 worker/网络，给足时间：L1 挂时降级到 L2 要下载分片
            const results = page.getByRole('link', { name: /.+/ });
            await expect(async () => {
                const count = await results.count();
                expect(count).toBeGreaterThan(3);
            }).toPass({ timeout: 90_000 });

            // 不该出现空状态文案
            await expect(page.getByText(/无匹配结果|無匹配結果|没有找到|沒有找到/)).toHaveCount(0);
        });
    }

    test('繁简查询召回同一部作品', async ({ page }) => {
        // 站内做了 opencc 归一化：搜「论语」和「論語」都应命中同一批条目。
        // 这条链路断了，简体用户会搜不到任何东西。
        const collect = async (q: string) => {
            await page.goto(`${TARGET}/book-index?q=${encodeURIComponent(q)}`);
            const links = page.locator('a[href*="id="]');
            await expect(async () => {
                expect(await links.count()).toBeGreaterThan(0);
            }).toPass({ timeout: 90_000 });

            const hrefs = await links.evaluateAll((els) =>
                els.map((e) => (e as HTMLAnchorElement).href.match(/id=([^&]+)/)?.[1]).filter(Boolean),
            );
            return new Set(hrefs as string[]);
        };

        const trad = await collect('論語');
        const simp = await collect('论语');
        const overlap = [...trad].filter((id) => simp.has(id));

        expect(
            overlap.length,
            `繁简搜索结果无交集：繁 ${trad.size} 条 / 简 ${simp.size} 条——opencc 归一化可能失效`,
        ).toBeGreaterThan(0);
    });

    test('搜索无结果时给出空状态而非报错', async ({ page }) => {
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(e.message));

        await page.goto(`${TARGET}/book-index?q=${encodeURIComponent('zzzz不可能存在的书名zzzz')}`);
        await expect(page.locator('main')).toBeVisible({ timeout: 60_000 });
        expect(errors, '空结果导致 JS 崩溃').toEqual([]);
    });
});
