/**
 * 详情页版式（2026-09 重构）。
 *
 * 这套用例守的是重构本身立下的几条不变量——它们坏掉时页面**不会报错**，
 * 只会悄悄退化成旧样子或丢数据：
 *   · 文档流滚动（旧版是固定高度 + 内部滚动，滚动条出现在页面中央）
 *   · 版本表按 cap 渲染，展开后给全量
 *   · 书目收录展开后能看到提要正文
 *   · 丛编子目表直接来自条目里的成员列表（旧 contained_works／新 _members），不对 books[] 逐条发请求
 */
import { test, expect, type Page } from '../fixtures/test';
import { ANCHORS, DATA_BASE, EMPTY_STATE_POOL, TARGET } from '../fixtures/anchors';
import {
    isEmptyEntity, isEmptyWork, pickEmptySample, requireUiVersion,
} from '../fixtures/preconditions';
import { readButton } from '../fixtures/detail';

/** 史記：35 个版本、9 条著录、90 条关联 */
const WORK = ANCHORS.work.id;
/** 御定佩文韻府：薈要本，23 册 */
const BOOK = '988fbiuha8';
/** 武英殿聚珍版叢書：144 条子目 */
const COLLECTION = '8rlcsybg2hhf';

/**
 * 表格行。0.10.0（N3a 三栏）起版本表、子目表、著作表都是 <table class="bim-d-zt">，
 * 之前是 .bim-d-row 的 div 行。两种都认，版本门禁切换前后同一条用例都能跑。
 */
const ROWS = '.bim-d-row, .bim-d-zt tbody tr';

/** 三栏版（N3a / N3b）上线的 book-index-ui 版本 */
const THREE_COLUMN = '0.10.0';

/**
 * 浏览器端查「升格对照表」（草稿 id → 正式 id）的请求：h1 指针、root、按后缀的分片。
 * web#310 起每个条目 id 解析前先取它所在的一片 `h1/promotions/<后缀>.<hash8>.json`
 * （旧布局下条目仍读 current/，升格查表走这一套）。它们不是「条目数据」，单独数、单独设上限。
 */
function isPromotionLookupRequest(url: string): boolean {
    if (!url.startsWith(`${DATA_BASE}/`)) return false;
    return isPromotionFullTableRequest(url)
        || /^\/h1\/(promotions\/|manifest-root\.json|roots\/)/.test(url.slice(DATA_BASE.length));
}

/** 整张 promotions.json（兜底路径 ensurePromotions；集部升格放量后约 14 MB）。正常页面一次都不该有。 */
function isPromotionFullTableRequest(url: string): boolean {
    return url.startsWith(`${DATA_BASE}/`) && /\/promotions\.json(\?|$)/.test(url.slice(DATA_BASE.length));
}

function isPromotionShardRequest(url: string): boolean {
    return url.startsWith(`${DATA_BASE}/`) && url.slice(DATA_BASE.length).startsWith('/h1/promotions/');
}

/**
 * 是不是一次「条目数据」请求：只数数据域（DATA_BASE）下的 entry/、items/、h1/，
 * 但升格对照表的查表请求（isPromotionLookupRequest）不算——这条守的是「不对子目逐条 getItem」，
 * 不是在管升格对照表。
 * 2026-09-27 起条目页地址是 /item/<id>（W2），原先的正则 /\/(entry|item|items)\//
 * 会把页面自己的地址和 app/item/[id] 的 JS chunk 也算进来，离上限只剩 1（网站总管裁决收窄）。
 */
function isEntryDataRequest(url: string): boolean {
    if (!url.startsWith(`${DATA_BASE}/`)) return false;
    if (isPromotionLookupRequest(url)) return false;
    return /\/(entry|items|h1)\//.test(url.slice(DATA_BASE.length));
}

/**
 * 升格分片请求的上限（web#310）：同一片只取一次（URL 不重复），且不多于条目请求数
 * （每个条目 id 最多要一片），再加指针＋root 各至多 2 次，整张 promotions.json 一次都不该下载。别只放宽阈值——重复取同一片
 * 或每次渲染都重新取，会在这里红。
 */
function expectPromotionLookupsBounded(requests: string[], entryRequestCount: number) {
    const shards = requests.filter(isPromotionShardRequest);
    expect(
        new Set(shards).size,
        `同一片升格分片被重复取了：${shards.join(' | ')}`,
    ).toBe(shards.length);
    expect(
        shards.length,
        `升格分片请求 ${shards.length} 次，多于条目请求 ${entryRequestCount} 次（每个 id 最多一片）`,
    ).toBeLessThanOrEqual(Math.max(entryRequestCount, 1));
    const fullTable = requests.filter(isPromotionFullTableRequest);
    expect(
        fullTable.length,
        `下载了整张 promotions.json（h1 查表失败后的兜底）：${fullTable.join(' | ')}`,
    ).toBe(0);
    const infra = requests.length - shards.length;
    expect(infra, `升格查表的指针／root 请求 ${infra} 次，应 ≤ 4`).toBeLessThanOrEqual(4);
}

async function openDetail(page: Page, id: string) {
    await page.goto(`${TARGET}/book-index?id=${id}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 30_000 });
    // 版本/子目要等 transport 逐条解析回来
    await page.waitForLoadState('networkidle');
}

test.describe('详情页版式', () => {
    // 这套版式是 0.7.0 的重构产物；线上还是旧版时用例自动休眠而非报红
    test.beforeEach(({ request }) => requireUiVersion(request, '0.7.0', '详情页版式重构'));

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

        const rows = page.locator(ROWS);
        const initial = await rows.count();
        // 默认只渲染 cap（12）条，不是一次性 35 条
        expect(initial, `首屏版本行数 ${initial}，应为 cap 12 条左右`).toBeLessThanOrEqual(14);
        expect(initial).toBeGreaterThan(5);

        // 文案随繁简切换（站点默认简体），两种都要认
        const more = page.getByRole('button', { name: /展[開开]其[餘余]\s*\d+\s*[種种]版本/ });
        await expect(more).toBeVisible();
        await more.click();

        await expect(async () => {
            expect(await rows.count()).toBeGreaterThan(initial);
        }).toPass({ timeout: 30_000 });
    });

    test('作品页：著录分栏，左列书目、右列提要正文', async ({ page, request }) => {
        // 「歷代書目收錄」的提要是这页最有价值的内容之一（史記 9 部书目里 8 部有提要）。
        // 0.10.0 起改成左列书目页签、右列原文，提要不用再点开，一眼可见。
        await requireUiVersion(request, THREE_COLUMN, '著录分栏');
        await openDetail(page, WORK);

        const catalogs = page.locator('#catalogs');
        await expect(catalogs).toBeVisible();

        const tabs = catalogs.getByRole('tab');
        expect(await tabs.count(), '著录书目页签少于 2 个').toBeGreaterThan(1);
        const panel = catalogs.getByRole('tabpanel');
        const first = await panel.innerText();
        expect(first.length, '右列没有提要正文').toBeGreaterThan(40);

        // 换一部书目，右列跟着换
        await tabs.nth(1).click();
        await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
        await expect(async () => {
            expect(await panel.innerText()).not.toBe(first);
        }).toPass({ timeout: 15_000 });
    });

    test('作品页：朝代筛选能过滤版本表', async ({ page }) => {
        await openDetail(page, WORK);

        // 朝代来自版本题名推断（生产仓 94% 的 Book 能推出朝代）
        // v3 起标签带条数（「宋 3」），条数须与筛选后的行数一致
        const song = page.getByRole('button', { name: /^宋(\s*\d+)?$/ });
        await expect(song, '史記有多个宋本，应出现「宋」筛选项').toBeVisible();
        const label = (await song.innerText()).trim();
        const count = Number(label.replace(/\D/g, '')) || 0;
        await song.click();

        await expect(async () => {
            const texts = await page.locator(ROWS).allInnerTexts();
            expect(texts.length).toBeGreaterThan(0);
            if (count > 0) {
                // 版本表默认最多显示 12 行，条数标签不应少于或多于实际可见行
                expect(texts.length, `「${label}」与筛选后行数不符`).toBe(Math.min(count, 12));
            }
            // 筛选后每行的年代列都该是宋
            for (const t of texts) {
                expect(t, `筛选「宋」后仍出现非宋版本：${t.slice(0, 40)}`).toMatch(/宋/);
            }
        }).toPass({ timeout: 15_000 });
    });

    test('版本页面包屑带真实链接，可 Ctrl+点击开新标签', async ({ page }) => {
        // 只挂 onClick 而 href="#" 的话，Ctrl+点击、中键、右键复制链接全废。
        await openDetail(page, BOOK);
        const crumb = page.locator('.bim-d-main a').filter({ hasText: /^作品$/ });
        await expect(crumb).toHaveCount(1);
        const href = await crumb.getAttribute('href');
        expect(href, `面包屑「作品」的 href 是 ${href}，应指向所属作品`).toMatch(/id=\w+/);
        await crumb.click();
        await expect(page).toHaveURL(/id=\w+/, { timeout: 30_000 });
        expect(page.url(), '点击后应离开版本页').not.toContain(BOOK);
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

    test('丛编页：子目表来自条目自带成员列表（contained_works 或 _members），不对 books 逐条发请求', async ({ page }) => {
        // 武英殿有 144 条子目。旧版对 books[] 逐条 getItem 只为拿标题，
        // 一个页面 144 次请求；contained_works 自带标题与册次。
        // schema-v2：成员列表是 _members（只含前 20 项，总数看 _member_count），表至少有 5 行即可。
        // 0.10.3 起为可见的 16 行补取撰人与卷数，再加上级丛编，约 17 次，仍须低于 20。
        const itemRequests: string[] = [];
        const promotionRequests: string[] = [];
        page.on('request', (r) => {
            if (isEntryDataRequest(r.url())) itemRequests.push(r.url());
            else if (isPromotionLookupRequest(r.url())) promotionRequests.push(r.url());
        });

        await openDetail(page, COLLECTION);
        await expect(page.getByRole('heading', { name: /^子目$/ })).toBeVisible();

        const rows = await page.locator(ROWS).count();
        expect(rows, '子目表没渲染出来').toBeGreaterThan(5);

        expect(
            itemRequests.length,
            `丛编页发了 ${itemRequests.length} 次条目请求；子目应直接取自条目自带的成员列表`,
        ).toBeLessThan(20);
        expectPromotionLookupsBounded(promotionRequests, itemRequests.length);
    });

    test('反馈入口不重复，但反馈页始终有返回入口', async ({ page }) => {
        // 顶条右侧已有「勘誤反饋」、页脚有「提交新版本」，
        // 次级导航再放一个就是同一动作一屏出现三次。
        await openDetail(page, WORK);
        const navChips = page.locator('.bim-d-main header + div button');
        const labels = await navChips.allInnerTexts();
        expect(
            labels.filter(t => /勘誤反饋|勘误反馈/.test(t)).length,
            `次级导航出现了反馈入口：${labels.join('|')}`,
        ).toBe(0);

        // 但进了反馈页必须能回来——史記只有「概览」一项，
        // nav 若因少于 2 项被整行隐藏，读者就只能按浏览器后退
        await page.goto(`${TARGET}/book-index?id=${WORK}&tab=feedback`);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 30_000 });
        await expect(
            page.locator('.bim-d-main button').filter({ hasText: /^概覽$|^概览$/ }),
        ).toHaveCount(1);
    });

    test('页脚显示版本信息与条目 ID', async ({ page }) => {
        await openDetail(page, WORK);
        // 原 CitationBar 的内容并入页脚：rev + 最近校订 + ID
        await expect(page.getByText(/rev\.\s*\d+\.\d+\.\d+/)).toBeVisible();
        await expect(page.getByText(new RegExp(WORK))).toBeVisible();
    });

    test('旧的 ?tab=emendated 链接不失效', async ({ page, request }) => {
        // 考證先并入正文区块（旧链接滚到 #studies），0.10.0 三栏版又只在提要卡里计数，
        // 不再有独立区块——旧链接至少要落到概览页，而不是空白或报错。
        await requireUiVersion(request, THREE_COLUMN, '三栏版概览');
        await page.goto(`${TARGET}/book-index?id=${WORK}&tab=emendated`);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 30_000 });
        await expect(page.locator('#versions')).toBeVisible({ timeout: 15_000 });
    });

    test('「閱讀」（旧版「閱讀全文」）是提要卡里唯一的主按钮，链到阅读页', async ({ page, request }) => {
        // N3b：网站给三栏组件传 readLink，地址约定 /read/<id>[/<章>]（主版本，新结构；overview#307）
        await requireUiVersion(request, THREE_COLUMN, '阅读全文入口');
        await openDetail(page, WORK);
        const read = readButton(page);
        await expect(read).toHaveCount(1);
        await expect(read).toHaveAttribute('href', new RegExp(`^/read/${WORK}(/\\d+)?$`));
    });

    test('左栏检索框回车进搜索结果页', async ({ page, request }) => {
        await requireUiVersion(request, THREE_COLUMN, '条目页左栏检索框');
        await openDetail(page, WORK);
        const box = page.getByRole('searchbox', { name: '检索古籍索引' });
        await box.fill('論語');
        await box.press('Enter');
        await expect(page).toHaveURL(/\/book-index\?q=/, { timeout: 30_000 });
    });

    test('窄屏下表格降级为两行布局且不横向溢出', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await openDetail(page, WORK);

        const overflow = await page.evaluate(() =>
            document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow, '窄屏出现横向滚动').toBeLessThanOrEqual(2);

        // 表头在窄屏隐藏，meta 折到第二行
        const headVisible = await page.locator('.bim-d-thead, .bim-d-zt thead').first().isVisible().catch(() => false);
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

    // EntityPage 重构随 0.7.2 上线。#177（5c74bd7）正是这批用例先于 0.7.2
    // 落到 main 造成的假红——有了这道门禁，那次就会是跳过而不是失败。
    test.beforeEach(({ request }) => requireUiVersion(request, '0.7.2', '人物页重构'));

    test('作品表按 cap 渲染，不再一次性挂 300 多个链接', async ({ page }) => {
        // 旧版把 308 部作品全渲染，页面高 9364px、一次 309 个链接、308 次请求
        const itemRequests: string[] = [];
        const promotionRequests: string[] = [];
        page.on('request', (r) => {
            if (isEntryDataRequest(r.url())) itemRequests.push(r.url());
            else if (isPromotionLookupRequest(r.url())) promotionRequests.push(r.url());
        });

        await openDetail(page, OUYANG);

        const rows = page.locator(ROWS);
        const n = await rows.count();
        expect(n, `首屏作品行 ${n} 条，应为 cap 16 条左右`).toBeLessThanOrEqual(18);
        expect(n).toBeGreaterThan(5);

        expect(
            itemRequests.length,
            `人物页发了 ${itemRequests.length} 次条目请求；只该解析可见行`,
        ).toBeLessThan(40);
        expectPromotionLookupsBounded(promotionRequests, itemRequests.length);

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
                const texts = await page.locator(ROWS).allInnerTexts();
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
        const rows = page.locator(ROWS);
        const before = await rows.count();
        // 0.10.0 起文案是「種著作」，之前是「條著作」
        const more = page.getByRole('button', { name: /展[開开]其[餘余]\s*\d+\s*[條条種种]著作/ });
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
 * 「页面坏了」。
 *
 * 样本不写死：「什么都没有」这个属性正是本项目每天在消灭的东西，锚死某个
 * ID 等于赌它永远没人整理。改为运行时从候选池里挑一个当下仍然为空的，
 * 池子与判据见 fixtures/anchors.ts 的 EMPTY_STATE_POOL。
 */
test.describe('空状态', () => {
    // 空状态说明随 0.7.3 上线。#179（dc995da）同理，是这批用例先于 0.7.3 落地。
    test.beforeEach(({ request }) => requireUiVersion(request, '0.7.3', '空状态说明'));

    test('无关联作品的人物页给出说明而非空白', async ({ page, request }) => {
        const sample = await pickEmptySample(request, EMPTY_STATE_POOL.entity, isEmptyEntity);
        test.skip(
            sample === null,
            `候选池 ${EMPTY_STATE_POOL.entity.length} 个人物均已有关联作品，` +
            `空状态无从验证——请按 anchors.ts 的口径重扫 book-index 补充候选`,
        );

        await openDetail(page, sample!.id);
        await expect(page.getByText(/尚未著錄該人物的關聯作品|尚未著录该人物的关联作品/))
            .toBeVisible();
    });

    test('什么都没有的作品页给出说明而非空白', async ({ page, request }) => {
        const sample = await pickEmptySample(request, EMPTY_STATE_POOL.work, isEmptyWork);
        test.skip(
            sample === null,
            `候选池 ${EMPTY_STATE_POOL.work.length} 部作品均已著录内容，` +
            `空状态无从验证——请按 anchors.ts 的口径重扫 book-index 补充候选`,
        );

        await openDetail(page, sample!.id);
        await expect(page.getByText(/尚未著錄該作品的版本|尚未著录该作品的版本/))
            .toBeVisible();
    });

    test('作者角色的英文占位值不渲染出来', async ({ page }) => {
        // 16 条 authors[].role 写成 "author"（录入工具占位值没换掉），
        // 直接渲染就是「紀昀等編 author」这种中英夹杂。
        // 这条不挑样本：它断言的是「不该出现」，数据被修好之后依然成立。
        await openDetail(page, '8rlb6yirb1ts');  // 欽定四庫全書·文溯閣本
        // 站点外壳自己也有一个 header，取详情页版心里的那个；0.10.0 起署名在右栏提要卡
        const byline = await page.locator('.bim-d-main header, .bim-d-card').first().innerText();
        expect(byline, `页头出现了英文占位值：${byline}`).not.toMatch(/\bauthor\b/i);
    });
});
