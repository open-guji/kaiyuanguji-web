/**
 * 详情页版式（2026-09 重构）。
 *
 * 这套用例守的是重构本身立下的几条不变量——它们坏掉时页面**不会报错**，
 * 只会悄悄退化成旧样子或丢数据：
 *   · 文档流滚动（旧版是固定高度 + 内部滚动，滚动条出现在页面中央）
 *   · 版本表按 cap 渲染，展开后给全量
 *   · 书目收录展开后能看到提要正文
 *   · 丛编子目表直接来自 contained_works，不对 books[] 逐条发请求
 */
import { test, expect, type Page } from '@playwright/test';
import { ANCHORS, TARGET } from '../fixtures/anchors';

/** 史記：35 个版本、9 条著录、90 条关联 */
const WORK = ANCHORS.work.id;
/** 御定佩文韻府：薈要本，23 册 */
const BOOK = '988fbiuha8';
/** 武英殿聚珍版叢書：144 条子目 */
const COLLECTION = '8rlcsybg2hhf';

async function openDetail(page: Page, id: string) {
    await page.goto(`${TARGET}/book-index?id=${id}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 30_000 });
    // 版本/子目要等 transport 逐条解析回来
    await page.waitForLoadState('networkidle');
}

test.describe('详情页版式', () => {
    test('整页随文档流滚动，没有内部滚动容器', async ({ page }) => {
        // 旧版把 calc(100vh - …) 传给 BookDetailLayout、内容区 overflow:auto，
        // 于是史記 4900px 的内容被塞进 836px 的窗口，滚动条出现在页面中央，
        // 浏览器原生的滚动位置记忆、Ctrl+F、锚点跳转全部失效。
        await openDetail(page, WORK);

        const innerScrollers = await page.evaluate(() =>
            [...document.querySelectorAll('body *')].filter((el) => {
                const s = getComputedStyle(el);
                return (s.overflowY === 'auto' || s.overflowY === 'scroll')
                    && el.scrollHeight > el.clientHeight + 50;
            }).length,
        );
        expect(innerScrollers, '详情页出现了内部滚动容器，说明又退回固定高度布局').toBe(0);

        // 页面本身必须够长（史記内容远超一屏），否则说明内容没渲染出来
        const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
        expect(pageHeight).toBeGreaterThan(1500);
    });

    test('站点只有一个 main 区域', async ({ page }) => {
        // 详情页外壳若自己再套一个 <main>，无障碍语义上就有两个主区域，
        // e2e 里 locator('main') 也会 strict mode violation。
        await openDetail(page, WORK);
        await expect(page.locator('main')).toHaveCount(1);
    });

    test('作品页：版本表分页渲染，展开后给全量', async ({ page }) => {
        await openDetail(page, WORK);

        const rows = page.locator('.bim-d-row');
        const initial = await rows.count();
        // 默认只渲染 cap（12）条，不是一次性 35 条
        expect(initial, `首屏版本行数 ${initial}，应为 cap 12 条左右`).toBeLessThanOrEqual(14);
        expect(initial).toBeGreaterThan(5);

        const more = page.getByRole('button', { name: /展開其餘\s*\d+\s*種版本/ });
        await expect(more).toBeVisible();
        await more.click();

        await expect(async () => {
            expect(await rows.count()).toBeGreaterThan(initial);
        }).toPass({ timeout: 30_000 });
    });

    test('作品页：书目收录展开后显示提要正文', async ({ page }) => {
        // 「歷代書目收錄」的提要是这页最有价值的内容之一（史記 9 部书目
        // 里 8 部有提要），旧版折在卡片里不展开就看不见。
        await openDetail(page, WORK);

        const catalogs = page.locator('#catalogs');
        await expect(catalogs).toBeVisible();

        const before = (await catalogs.innerText()).length;
        await catalogs.getByRole('button', { name: '＋' }).first().click();

        await expect(async () => {
            const after = (await catalogs.innerText()).length;
            expect(after, '展开后没有新增文本，提要没渲染出来').toBeGreaterThan(before + 40);
        }).toPass({ timeout: 15_000 });
    });

    test('作品页：朝代筛选能过滤版本表', async ({ page }) => {
        await openDetail(page, WORK);

        // 朝代来自版本题名推断（生产仓 94% 的 Book 能推出朝代）
        const song = page.getByRole('button', { name: /^宋$/ });
        await expect(song, '史記有多个宋本，应出现「宋」筛选项').toBeVisible();
        await song.click();

        await expect(async () => {
            const texts = await page.locator('.bim-d-row').allInnerTexts();
            expect(texts.length).toBeGreaterThan(0);
            // 筛选后每行的年代列都该是宋
            for (const t of texts) {
                expect(t, `筛选「宋」后仍出现非宋版本：${t.slice(0, 40)}`).toMatch(/宋/);
            }
        }).toPass({ timeout: 15_000 });
    });

    test('版本页：显示所属作品、收入丛编与册次', async ({ page }) => {
        await openDetail(page, BOOK);

        await expect(page.getByRole('heading', { level: 1 }))
            .toHaveText(/御定佩文韻府|御定佩文韵府/);
        // 收入丛编 + 所属作品，这两块是版本页的核心关联
        await expect(page.getByRole('heading', { name: /收入/ })).toBeVisible();
        await expect(page.getByRole('heading', { name: /所屬作品|所属作品/ })).toBeVisible();
        // 23 册的册次（321–343）
        await expect(page.getByText('321').first()).toBeVisible();
        await expect(page.getByText('343').first()).toBeVisible();
    });

    test('丛编页：子目表来自 contained_works，不对 books 逐条发请求', async ({ page }) => {
        // 武英殿有 144 条子目。旧版对 books[] 逐条 getItem 只为拿标题，
        // 一个页面 144 次请求；contained_works 自带标题与册次，应为 0 次。
        const itemRequests: string[] = [];
        page.on('request', (r) => {
            if (/\/(entry|item|items)\//.test(r.url())) itemRequests.push(r.url());
        });

        await openDetail(page, COLLECTION);
        await expect(page.getByRole('heading', { name: /收錄書籍|收录书籍/ })).toBeVisible();

        const rows = await page.locator('.bim-d-row').count();
        expect(rows, '子目表没渲染出来').toBeGreaterThan(5);

        expect(
            itemRequests.length,
            `丛编页发了 ${itemRequests.length} 次条目请求；子目应直接取自 contained_works`,
        ).toBeLessThan(20);
    });

    test('页脚显示版本信息与条目 ID', async ({ page }) => {
        await openDetail(page, WORK);
        // 原 CitationBar 的内容并入页脚：rev + 最近校订 + ID
        await expect(page.getByText(/rev\.\s*\d+\.\d+\.\d+/)).toBeVisible();
        await expect(page.getByText(new RegExp(WORK))).toBeVisible();
    });

    test('旧的 ?tab=emendated 链接不失效', async ({ page }) => {
        // 考證已从独立 tab 并入正文区块，旧链接改为滚到锚点
        await page.goto(`${TARGET}/book-index?id=${WORK}&tab=emendated`);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 30_000 });
        await expect(page.locator('#studies')).toBeVisible({ timeout: 15_000 });
    });

    test('窄屏下表格降级为两行布局且不横向溢出', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await openDetail(page, WORK);

        const overflow = await page.evaluate(() =>
            document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow, '窄屏出现横向滚动').toBeLessThanOrEqual(2);

        // 表头在窄屏隐藏，meta 折到第二行
        const headVisible = await page.locator('.bim-d-thead').first().isVisible().catch(() => false);
        expect(headVisible, '窄屏不应显示表头').toBe(false);
    });
});
