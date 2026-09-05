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

/**
 * 人物页（2026-09-05 重构）。
 *
 * 设计稿另有「籍貫 / 官至 / 傳記出處 / 相關人物」四块，数据里没有对应字段
 * （全量 30,120 条 Entity 实测 0%），本次未实现——所以这里不断言它们。
 */
test.describe('人物页', () => {
    /** 歐陽修：308 部作品、6 别名跨 5 类、CBDB 1384 */
    const OUYANG = 'hixhd2h9bdye';
    /** 傅山：67 个别名（號 38 / 別名 24 / 字 5） */
    const FUSHAN = 'hixhd2h9bd3y';

    test('作品表按 cap 渲染，不再一次性挂 300 多个链接', async ({ page }) => {
        // 旧版把 308 部作品全渲染，页面高 9364px、一次 309 个链接、308 次请求
        const itemRequests: string[] = [];
        page.on('request', (r) => {
            if (/\/(entry|item|items)\//.test(r.url())) itemRequests.push(r.url());
        });

        await openDetail(page, OUYANG);

        const rows = page.locator('.bim-d-row');
        const n = await rows.count();
        expect(n, `首屏作品行 ${n} 条，应为 cap 16 条左右`).toBeLessThanOrEqual(18);
        expect(n).toBeGreaterThan(5);

        expect(
            itemRequests.length,
            `人物页发了 ${itemRequests.length} 次条目请求；只该解析可见行`,
        ).toBeLessThan(40);

        const height = await page.evaluate(() => document.documentElement.scrollHeight);
        expect(height, '页面高度回到合理量级（旧版 9364px）').toBeLessThan(4000);
    });

    test('职任筛选归一后 chips 可控，且能过滤', async ({ page }) => {
        // 全量 307 种 role 写法归一到 撰/編/注/校/譯/繪/其他
        await openDetail(page, OUYANG);

        const chips = page.getByRole('button', { name: /^(全部|撰|編|注|校|譯|繪|其他)\s+\d+$/ });
        const count = await chips.count();
        expect(count, `职任 chips ${count} 个，归一后不该超过 8 个`).toBeLessThanOrEqual(8);
        expect(count).toBeGreaterThanOrEqual(2);

        // 点「編」后每行职任列都应属编辑类
        const bian = page.getByRole('button', { name: /^編\s+\d+$/ });
        if (await bian.count()) {
            await bian.click();
            await expect(async () => {
                const texts = await page.locator('.bim-d-row').allInnerTexts();
                expect(texts.length).toBeGreaterThan(0);
            }).toPass({ timeout: 15_000 });
        }
    });

    test('别名按类分组，正式名号在前', async ({ page }) => {
        // 傅山 67 个别名（號 38 / 別名 24 / 字 5）。不分组就是平铺一片，
        // 且「字」「號」这类正式名号会淹没在斋号、诨名里。
        await openDetail(page, FUSHAN);

        // 取 intro 区的纯文本，按标签出现位置判断分组顺序。
        // 不用 getByText('字')——「字」在页面别处也出现，会命中别的节点。
        const order = await page.evaluate(() => {
            const el = document.querySelector('.bim-d-intro') ?? document.body;
            const txt = (el as HTMLElement).innerText;
            return {
                text: txt,
                zi: txt.indexOf('字'),
                hao: txt.indexOf('號') >= 0 ? txt.indexOf('號') : txt.indexOf('号'),
                bie: txt.indexOf('別名') >= 0 ? txt.indexOf('別名') : txt.indexOf('别名'),
            };
        });

        expect(order.zi, 'intro 区没有「字」分组').toBeGreaterThanOrEqual(0);
        expect(order.hao, 'intro 区没有「號」分组').toBeGreaterThanOrEqual(0);
        expect(order.bie, 'intro 区没有「別名」分组').toBeGreaterThanOrEqual(0);
        // 正式名号（字、號）排在次要的「別名」之前
        expect(order.zi, '「字」应排在「別名」之前').toBeLessThan(order.bie);
        expect(order.hao, '「號」应排在「別名」之前').toBeLessThan(order.bie);
    });

    test('展开后给出全部作品', async ({ page }) => {
        await openDetail(page, OUYANG);
        const rows = page.locator('.bim-d-row');
        const before = await rows.count();
        const more = page.getByRole('button', { name: /展開其餘\s*\d+\s*條著作/ });
        await expect(more).toBeVisible();
        await more.click();
        await expect(async () => {
            expect(await rows.count()).toBeGreaterThan(before);
        }).toPass({ timeout: 30_000 });
    });
});

/**
 * 空状态。
 *
 * 数据稀疏的条目在页面上只剩标题和页脚，读者分不清是「没数据」还是
 * 「页面坏了」。生产仓实测：
 *   人物无关联作品        450 / 30,122（1.5%），其中 389 条连别名简介都没有
 *   作品什么都没有        377 / 91,730（0.4%）
 */
test.describe('空状态', () => {
    test('无关联作品的人物页给出说明而非空白', async ({ page }) => {
        await openDetail(page, 'hixhd2h9bcme');  // 蔣良驥：作品 0 别名 0
        await expect(page.getByText(/尚未著錄該人物的關聯作品|尚未著录该人物的关联作品/))
            .toBeVisible();
    });

    test('什么都没有的作品页给出说明而非空白', async ({ page }) => {
        await openDetail(page, 'd59f2q8ge0ap');  // 田穰苴司馬法：无版本/资源/著录/关联/简介
        await expect(page.getByText(/尚未著錄該作品的版本|尚未著录该作品的版本/))
            .toBeVisible();
    });

    test('作者角色的英文占位值不渲染出来', async ({ page }) => {
        // 16 条 authors[].role 写成 "author"（录入工具占位值没换掉），
        // 直接渲染就是「紀昀等編 author」这种中英夹杂
        await openDetail(page, '8rlb6yirb1ts');  // 欽定四庫全書·文溯閣本
        // 站点外壳自己也有一个 header，取详情页版心里的那个
        const byline = await page.locator('.bim-d-main header').innerText();
        expect(byline, `页头出现了英文占位值：${byline}`).not.toMatch(/\bauthor\b/i);
    });
});
