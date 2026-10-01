/**
 * 整理本渲染 —— 本次故障的重灾区，守门用例最密。
 *
 * 覆盖 2026-09-02～03 连续暴露的四个 bug：
 *   1. 清单档改名（collated_edition_index.json → index.json）没跟上 → 整个 tab 消失
 *   2. BundleStorage 读被 CDN 缓存的 version.json → items/* 请求拼错版本号 → 404
 *   3. section.type 英文枚举未识别 → 书名标题不渲染、目录退化成裸文本
 *   4. 同上 → 统计显示"0 部书"
 *
 * 选择器策略：不用 data-testid（生产代码里没有，加它要改 book-index-ui 并重新
 * 发包），改用用户可见文本 + ARIA role——更贴近真人视角，且组件重构时不易失效。
 */
import { test, expect } from '@playwright/test';
import { ANCHORS, TARGET } from '../fixtures/anchors';
import { cmpVersion, fetchUiVersion, requireNewTextData } from '../fixtures/preconditions';

const C = ANCHORS.collated;

/** 页面同时支持繁简切换，断言时两种写法都接受 */
function eitherScript(traditional: string, simplified: string): RegExp {
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`${esc(traditional)}|${esc(simplified)}`);
}

test.describe('整理本', () => {
    // 阅读页只认新结构（overview#307）：文本迁移落地前，这组针对阅读页内容的用例整体休眠
    test.beforeEach(({ request }) => requireNewTextData(request, C.id, '整理本阅读页（新结构）'));

    test('概览页有整理本入口', async ({ page, request }) => {
        await page.goto(`${TARGET}/book-index?id=${C.id}`);

        // N3b（0.10.0 三栏条目页）：横幅没了，入口是提要卡里的「阅读全文」链接，整理本 → /read/<id>/<章>（新结构，主版本不写 key）。
        // 守的仍是「清单档 404 时入口别静默消失」。
        const live = await fetchUiVersion(request);
        if (live !== null && cmpVersion(live, '0.10.0') >= 0) {
            await expect(
                page.getByRole('link', { name: /^(阅读|閱讀)全文$/ }),
                '整理本入口不存在：清单档可能 404（文件名或版本号错）',
            ).toHaveAttribute('href', new RegExp(`^/read/${C.id}(/|$)`), { timeout: 30_000 });
            return;
        }

        /*
         * 整理本入口曾经整个消失——清单档 404 被静默 catch 成 null，无任何报错。
         * 守的是「入口存在」这件事，不是它长什么样：0.9.0 把入口从顶部 tab
         * 改成了正文里的横幅（tab 与横幅、「作品信息 →」三者指同两个地方，
         * 属重复），故这里锚横幅文案。
         *
         * Work 全文接入全文 tab（W6c）后，有 Work 全文的书另出一条「全文阅读」横幅（名字带来源，如
         * 「维基文库 · 全文检索 · 原书对照」），本书两条都有。整理本横幅的名字以
         * 带卷数（「…全文阅读 56 卷 · 全文检索 · 原书对照」），
         * Work 全文那条带来源名、没有卷数，据此只锚整理本那条。
         */
        await expect(
            page.getByRole('button', {
                name: new RegExp(`(全文閲讀|全文阅读)\\s*${C.juanFileCount}\\s*卷`),
            }),
            '整理本入口不存在：清单档可能 404（文件名或版本号错）',
        ).toBeVisible({ timeout: 30_000 });
    });

    test('URL 不带 juan 时自动选中首卷并渲染正文', async ({ page, request }) => {
        // N5b：全栈站上旧入口 ?tab=collated 308 到新阅读器 /read/<id>，
        // 旧阅读区（.bim-d-reader-main）不再出现；同一回归由 reader.spec「不带 juan 进来自动选首卷」守。
        const live = await fetchUiVersion(request);
        test.skip(live !== null && cmpVersion(live, '0.10.0') >= 0, `book-index-ui ${live} 用新阅读器，本条由 reader.spec 覆盖`);
        /*
         * 读者从概览页横幅点进整理本，URL 里是没有 juan 参数的。此时必须
         * 自动选中第一卷——否则侧栏列着卷号、正文区空白，看起来像没加载出来。
         *
         * 0.9.0 曾把这个 effect 连同「indexProp 到达时清 loading」一起误删，
         * 线上整理本页面卡在「加载整理本...」，0.9.1 补回。这条用例守的就是
         * 那次回归：它只在不带 juan 参数时才暴露，带参数的用例一概照过。
         */
        await page.goto(`${TARGET}/book-index?id=${C.id}&tab=collated`);

        // 不能停在加载态
        await expect(
            page.getByText(/加载整理本|加載整理本/),
            '卡在「加载整理本...」：indexProp 到达后没有清 loading',
        ).toBeHidden({ timeout: 30_000 });

        // 正文区必须有实际内容（自动选中的首卷渲染出来了）
        const main = page.locator('.bim-d-reader-main');
        await expect(main).toBeVisible({ timeout: 30_000 });
        await expect(
            main.getByText(/目錄|目录/),
            '正文区空白：URL 无 juan 参数时没有自动选中首卷',
        ).toBeVisible({ timeout: 30_000 });
    });

    test('侧栏章目录条数与 index.json 的 chapters 条数一致', async ({ page }) => {
        /*
         * 章数来源是 default/index.json 的 chapters（旧的 juan_files／total_juan 都不再有）。
         * 统一阅读器（TextReader）的目录是 role=navigation「目录」里的一排按钮，每个按钮带 data-rd-toc-key（章文件名 001…）；
         * 不按按钮文字找——文字是章名（「卷1　易類」「第三回」），随整理变；按 key 数才是「有几章」。
         */
        await page.goto(`${TARGET}/read/${C.id}`);

        const toc = page.getByRole('navigation', { name: '目录' }).locator('[data-rd-toc-key]');
        // 先等第一章出现再数：目录随 index.json 异步到达
        await expect(toc.first()).toBeVisible({ timeout: 30_000 });
        // 用会重试的 toHaveCount 而非一次性 count()：自动选中首章触发的重渲染会让目录短暂清空
        await expect(
            toc,
            '目录条数与 chapters 条数不符——章数来源又被改回不可信字段了？',
        ).toHaveCount(C.juanFileCount, { timeout: 30_000 });
        await expect(toc.first(), '章的 key 是三位编号').toHaveAttribute('data-rd-toc-key', '001');
    });

    test('目录视图渲染书名标题与正确统计', async ({ page }) => {
        await page.goto(
            `${TARGET}/book-index?id=${C.id}&tab=collated&juan=${encodeURIComponent(C.sampleJuanFile)}`,
        );

        // 分类标题
        await expect(
            page.getByRole('heading', {
                name: eitherScript(C.sampleJuanCategory, C.sampleJuanCategorySimplified),
            }),
        ).toBeVisible({ timeout: 30_000 });

        // 统计：修复前恒为"0 部书"（type 是英文 'book'，代码却比对中文 '书'）
        // 阅读页 v3（0.25.0）起卷头与右栏都出现「N 部书」字样，取第一处：仍要求页面上显示 N 部书。
        await expect(
            page.getByText(new RegExp(`${C.sampleJuanBookCount}\\s*部[书書]`)).first(),
            `书目统计不对：期望 ${C.sampleJuanBookCount} 部书。显示 0 = section.type 映射失效`,
        ).toBeVisible();

        // 书名标题：修复前只渲染 content，标题完全不可见（用户："没有书的索引"）
        await expect(
            page.getByText(
                eitherScript(C.sampleJuanFirstBook, C.sampleJuanFirstBookSimplified),
            ).first(),
            '首条书目标题未渲染——退化成了 OtherSection 兜底（只显示 content）',
        ).toBeVisible();
    });

    test('原文视图有内容且带书名标题', async ({ page, request }) => {
        await page.goto(
            `${TARGET}/book-index?id=${C.id}&tab=collated&juan=${encodeURIComponent(C.sampleJuanFile)}`,
        );
        // N5b（0.10.0 新阅读器）：「原文」视图改名「正文」
        const live = await fetchUiVersion(request);
        const rawView = live !== null && cmpVersion(live, '0.10.0') >= 0 ? /^正文$/ : /^原文$/;
        await page.getByRole('button', { name: rawView }).click();

        // 修复前 RawTextView 的分组循环一条都匹配不上，groups 为空 → 整页空白
        await expect(
            page.getByText(
                eitherScript(C.sampleJuanFirstBook, C.sampleJuanFirstBookSimplified),
            ).first(),
            '原文视图空白或无书名标题——RawTextView 分组逻辑未匹配到 section',
        ).toBeVisible({ timeout: 15_000 });
    });

    test('文本数据请求都成功、不 404（章目录与章文件）', async ({ page }) => {
        // 直接盯网络层：数据路径或版本号错时整片 404。数据布局有两种——current/items/<id>/…（带 ?v=<版本号>）
        // 与按内容哈希的 h1/text/<id>/…（文件名里带哈希，不需要 ?v=）；站点用哪种都认。
        const itemRequests: { url: string; status: number }[] = [];
        page.on('response', (res) => {
            const u = res.url();
            if ((u.includes('/current/items/') || u.includes('/h1/text/')) && u.includes(C.id)) {
                itemRequests.push({ url: u, status: res.status() });
            }
        });

        await page.goto(`${TARGET}/read/${C.id}/${C.sampleJuanFile.replace(/^juan\/|\.json$/g, '')}`);
        await expect(
            page.getByRole('heading', {
                name: eitherScript(C.sampleJuanCategory, C.sampleJuanCategorySimplified),
            }),
        ).toBeVisible({ timeout: 30_000 });

        expect(itemRequests.length, '没有发出任何文本数据请求').toBeGreaterThan(0);
        expect(
            itemRequests.some((r) => /\/default\/index(\.[0-9a-f]+)?\.json/.test(r.url) && r.status === 200),
            '没有成功取到 default/index.json（章目录）',
        ).toBe(true);

        // current/ 布局的请求必须带当前版本号做 cache-bust——版本号分裂时这里会露馅
        // 版本键：cacheKey 16 位 hex；旧数据回退 commitId 12 位
        const badVersion = itemRequests
            .filter((r) => r.url.includes('/current/items/'))
            .filter((r) => !/[?&]v=([0-9a-f]{16}|[0-9a-f]{12})(&|$)/.test(r.url));
        expect(
            badVersion.map((r) => r.url),
            'items 请求缺少 ?v= 版本号（或格式不对），CDN 会返回陈旧内容',
        ).toEqual([]);

        // 允许 404 的「可选资源」——前端探测不到就降级，属设计内行为：
        //   lineage_graph.json —— 多数书没有版本传承图
        //   章 md（.txt）—— 整理本的章可以只有结构化 json（has_json），md 可缺
        const OPTIONAL = /lineage_graph\.json|\.txt(\?|$)|\.[0-9a-f]{8}\.md(\?|$)/;
        const failed = itemRequests.filter((r) => r.status >= 400 && !OPTIONAL.test(r.url));
        expect(
            failed.map((f) => `${f.status} ${f.url}`),
            '必需的文本数据请求失败——多半是路径或版本号错',
        ).toEqual([]);
    });
});
