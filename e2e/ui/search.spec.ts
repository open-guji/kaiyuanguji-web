/**
 * 站内搜索 —— 繁简互通 + L1/L2 降级。
 *
 * 搜索是两层架构，L1(Meili) 挂了会静默降级到 L2(worker 分片)。这里只断言
 * "用户能搜到东西"，不区分走的哪层——分层健康由 contract/search-backend
 * 负责。这样即便 L1 故障，只要降级正常工作，UI 用例仍应通过。
 */
import { test, expect } from '@playwright/test';
import { SEARCH_QUERIES, TARGET } from '../fixtures/anchors';
import { requireUiVersion } from '../fixtures/preconditions';

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
            // v3 起结果行链到 /item/<id>；更早是 /book-index?id=<id>。两种都认
            const links = page.locator('a[href*="id="], a[href^="/item/"]');
            await expect(async () => {
                expect(await links.count()).toBeGreaterThan(0);
            }).toPass({ timeout: 90_000 });

            const hrefs = await links.evaluateAll((els) =>
                els.map((e) => {
                    const h = (e as HTMLAnchorElement).href;
                    return h.match(/id=([^&]+)/)?.[1] ?? h.match(/\/item\/([^/?#]+)/)?.[1];
                }).filter(Boolean),
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

    test('title 带检索词；点结果卡直接到 /item/<id>，不停在 /book-index?id=（overview#267 P2-7、P2-9）', async ({ page }) => {
        await page.goto(`${TARGET}/book-index?q=${encodeURIComponent('朱熹')}`);
        await expect(page).toHaveTitle('朱熹 - 搜索 - 开源古籍');
        await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', /\/book-index$/);

        // 结果链接：v4 是表格题名／卡片（.bim-sr-table／.bim-sc），v3 是 .bim-result-card
        const card = page.locator('a.bim-result-card, .bim-sr-table td.bim-sr-c-title a, a.bim-sc').first();
        await expect(card).toBeVisible({ timeout: 90_000 });
        await expect(card).toHaveAttribute('href', /^\/item\/[0-9a-z]+$/);
        await card.click();
        await expect(page, '点结果卡后地址应是条目页自己的').toHaveURL(/\/item\/[0-9a-z]+$/, { timeout: 30_000 });
    });
});

test.describe('搜索页 v4：筛选、表格／卡片（overview#298）', () => {
    test.beforeEach(({ request }) => requireUiVersion(request, '0.28.0', '搜索页 v4 筛选与表格'));

    const Q = encodeURIComponent('史記');
    const rows = (page: import('@playwright/test').Page) => page.locator('.bim-sr-table tbody tr');

    test('默认是表格，六列表头；点题名到 /item/<id>', async ({ page }) => {
        await page.goto(`${TARGET}/book-index?q=${Q}`);
        await expect(rows(page).first()).toBeVisible({ timeout: 90_000 });
        const heads = await page.locator('.bim-sr-table thead th').allInnerTexts();
        expect(heads.map((h) => h.trim())).toEqual(expect.arrayContaining([expect.stringMatching(/^(题名|題名)$/), expect.stringMatching(/^(部类|部類)$/)]));
        const link = rows(page).first().locator('td.bim-sr-c-title a');
        await expect(link).toHaveAttribute('href', /^\/item\/[0-9a-z]+$/);
    });

    test('朝代＋部类组合：结果按条件收窄；URL 往返；清除全部', async ({ page }) => {
        await page.goto(`${TARGET}/book-index?q=${Q}`);
        await expect(rows(page).first()).toBeVisible({ timeout: 90_000 });

        await page.getByRole('button', { name: '清', exact: true }).click();
        await page.getByRole('checkbox', { name: '史部' }).click();
        await expect(page).toHaveURL(/[?&]dy=%E6%B8%85|[?&]dy=清/);
        await expect(page).toHaveURL(/cls=/);
        await expect(async () => {
            const n = await rows(page).count();
            expect(n).toBeGreaterThan(0);
            const eras = await page.locator('.bim-sr-table td.bim-sr-c-era').allInnerTexts();
            const cls = await page.locator('.bim-sr-table td.bim-sr-c-cls').allInnerTexts();
            for (const e of eras) expect(e.trim(), '朝代筛选「清」后仍出现非清').toBe('清');
            for (const c of cls) expect(c.trim(), '部类筛选「史部」后仍出现非史部').toBe('史部');
        }).toPass({ timeout: 60_000 });
        await expect(page.getByText(/筛出|篩出/)).toBeVisible();

        // URL 往返：刷新后筛选还在
        const first = await rows(page).first().innerText();
        await page.reload();
        await expect(page.getByRole('button', { name: '清', exact: true })).toHaveAttribute('aria-pressed', 'true', { timeout: 60_000 });
        await expect(page.getByRole('checkbox', { name: '史部' })).toBeChecked();
        await expect(rows(page).first()).toContainText(first.split('\n')[0].trim().slice(0, 2), { timeout: 60_000 });

        // 清除全部
        await page.getByRole('button', { name: /清除全部筛选|清除全部篩選/ }).click();
        await expect(page).not.toHaveURL(/dy=|cls=/);
        await expect(page.getByRole('checkbox', { name: '史部' })).not.toBeChecked();
    });

    test('表格／卡片切换，选择记在浏览器里', async ({ page }) => {
        await page.goto(`${TARGET}/book-index?q=${Q}`);
        await expect(rows(page).first()).toBeVisible({ timeout: 90_000 });
        await page.getByRole('button', { name: /^(卡片)$/ }).click();
        await expect(page.locator('a.bim-sc').first()).toBeVisible();
        await expect(page.locator('.bim-sr-table')).toHaveCount(0);
        await page.reload();
        await expect(page.locator('a.bim-sc').first()).toBeVisible({ timeout: 60_000 });
        await page.getByRole('button', { name: /^(表格)$/ }).click();
        await expect(rows(page).first()).toBeVisible();
    });

    test('排序：点「年代」sort 进 URL 且仍有结果；再点翻转方向；点「相关度」还原（排序生效要等索引重建，这里只验交互与不报错）', async ({ page }) => {
        await page.goto(`${TARGET}/book-index?q=${Q}`);
        await expect(rows(page).first()).toBeVisible({ timeout: 90_000 });
        const sorts = page.locator('.bim-sr-sorts');
        await sorts.getByRole('button', { name: /^年代|^年代/ }).click();
        await expect(page).toHaveURL(/sort=era(%3A|:)asc/);
        await expect(rows(page).first()).toBeVisible({ timeout: 60_000 });
        await sorts.getByRole('button', { name: /年代/ }).click();
        await expect(page).toHaveURL(/sort=era(%3A|:)desc/);
        await expect(rows(page).first()).toBeVisible({ timeout: 60_000 });
        await sorts.getByRole('button', { name: /^(相关度|相關度)$/ }).click();
        await expect(page).not.toHaveURL(/sort=/);
    });

    test('翻页：点作品页签有页码，点第 2 页换一批', async ({ page }) => {
        await page.goto(`${TARGET}/book-index?q=${Q}`);
        await expect(rows(page).first()).toBeVisible({ timeout: 90_000 });
        await page.locator('.bim-sr-main [aria-label="结果分类"], .bim-sr-main [aria-label="結果分類"]').getByRole('button', { name: /^(作品)/ }).click();
        const pager = page.getByRole('navigation', { name: /翻页|翻頁/ });
        await expect(pager).toBeVisible({ timeout: 60_000 });
        const before = await rows(page).first().innerText();
        await pager.getByRole('button', { name: '2', exact: true }).click();
        await expect(pager.getByRole('button', { name: '2', exact: true })).toHaveAttribute('aria-current', 'page', { timeout: 60_000 });
        await expect(async () => {
            expect(await rows(page).first().innerText()).not.toBe(before);
        }).toPass({ timeout: 60_000 });
    });

    test('页签进地址：点作品写 ?tab=work，刷新后仍在作品页签（overview#359 P2-3）', async ({ page }) => {
        await page.goto(`${TARGET}/book-index?q=${Q}`);
        await expect(rows(page).first()).toBeVisible({ timeout: 90_000 });
        const tabs = page.locator('.bim-sr-main [aria-label="结果分类"], .bim-sr-main [aria-label="結果分類"]');
        await tabs.getByRole('button', { name: /^(作品)/ }).click();
        await expect(page).toHaveURL(/[?&]tab=work(&|$)/);
        await page.reload();
        await expect(tabs.getByRole('button', { name: /^(作品)/ })).toHaveAttribute('aria-pressed', 'true', { timeout: 90_000 });
        await tabs.getByRole('button', { name: /^全部/ }).click();
        await expect(page).not.toHaveURL(/[?&]tab=/);
    });

    test('页码进地址：第 2 页写 ?page=2，刷新后仍在第 2 页；翻页后回到结果区顶部', async ({ page }) => {
        await page.goto(`${TARGET}/book-index?q=${Q}`);
        await expect(rows(page).first()).toBeVisible({ timeout: 90_000 });
        const tabs = page.locator('.bim-sr-main [aria-label="结果分类"], .bim-sr-main [aria-label="結果分類"]');
        await tabs.getByRole('button', { name: /^(作品)/ }).click();
        const pager = page.getByRole('navigation', { name: /翻页|翻頁/ });
        await expect(pager).toBeVisible({ timeout: 60_000 });
        await pager.scrollIntoViewIfNeeded();
        await pager.getByRole('button', { name: '2', exact: true }).click();
        await expect(page).toHaveURL(/[?&]page=2(&|$)/);
        await expect(page).toHaveURL(/[?&]tab=work(&|$)/);
        const top = await page.locator('.bim-sr-main').evaluate((el) => el.getBoundingClientRect().top);
        expect(top, '翻页后结果区顶部应在视口内').toBeGreaterThanOrEqual(-1);
        await page.reload();
        await expect(page.getByRole('navigation', { name: /翻页|翻頁/ }).getByRole('button', { name: '2', exact: true }))
            .toHaveAttribute('aria-current', 'page', { timeout: 90_000 });
        // 换页签：page 去掉
        await tabs.getByRole('button', { name: /^全部/ }).click();
        await expect(page).not.toHaveURL(/[?&]page=/);
    });

    test('手机 390：筛选收成按钮、点开才出面板；表格不横向溢出', async ({ browser }) => {
        const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
        const page = await ctx.newPage();
        try {
            await page.goto(`${TARGET}/book-index?q=${Q}`);
            await expect(rows(page).first()).toBeVisible({ timeout: 90_000 });
            const btn = page.locator('.bim-sr-fbtn');
            await expect(btn).toBeVisible();
            await expect(page.getByRole('checkbox', { name: '史部' })).toBeHidden();
            await btn.click();
            await expect(page.getByRole('checkbox', { name: '史部' })).toBeVisible();
            const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
            expect(overflow, '手机上页面横向溢出').toBeLessThanOrEqual(1);
        } finally {
            await ctx.close();
        }
    });
});
