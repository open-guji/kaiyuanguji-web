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

const C = ANCHORS.collated;

/** 页面同时支持繁简切换，断言时两种写法都接受 */
function eitherScript(traditional: string, simplified: string): RegExp {
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`${esc(traditional)}|${esc(simplified)}`);
}

test.describe('整理本', () => {
    test('详情页显示「整理本」tab', async ({ page }) => {
        await page.goto(`${TARGET}/book-index?id=${C.id}`);

        // 这个 tab 曾经整个消失——清单档 404 被静默 catch 成 null，无任何报错
        await expect(
            page.getByRole('button', { name: eitherScript('整理本', '整理本') }),
            '「整理本」tab 不存在：清单档可能 404（文件名或版本号错）',
        ).toBeVisible({ timeout: 30_000 });
    });

    test('卷列表完整且卷数正确', async ({ page }) => {
        await page.goto(`${TARGET}/book-index?id=${C.id}&tab=collated`);

        await expect(page.getByText(new RegExp(`共\\s*${C.totalJuan}\\s*卷`))).toBeVisible({
            timeout: 30_000,
        });

        // 卷按钮应有 juan_files 条（含卷首/附录，数量 ≥ total_juan）
        const juanButtons = page.getByRole('button', { name: /^卷\// });
        expect(await juanButtons.count()).toBeGreaterThanOrEqual(C.totalJuan);
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
        await expect(
            page.getByText(new RegExp(`${C.sampleJuanBookCount}\\s*部[书書]`)),
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

    test('原文视图有内容且带书名标题', async ({ page }) => {
        await page.goto(
            `${TARGET}/book-index?id=${C.id}&tab=collated&juan=${encodeURIComponent(C.sampleJuanFile)}`,
        );
        await page.getByRole('button', { name: /^原文$/ }).click();

        // 修复前 RawTextView 的分组循环一条都匹配不上，groups 为空 → 整页空白
        await expect(
            page.getByText(
                eitherScript(C.sampleJuanFirstBook, C.sampleJuanFirstBookSimplified),
            ).first(),
            '原文视图空白或无书名标题——RawTextView 分组逻辑未匹配到 section',
        ).toBeVisible({ timeout: 15_000 });
    });

    test('items 请求使用当前版本号且不 404', async ({ page }) => {
        // 直接盯网络层：版本号分裂时 URL 会带上过期 commit，整片 404
        const itemRequests: { url: string; status: number }[] = [];
        page.on('response', (res) => {
            const u = res.url();
            if (u.includes('/current/items/') && u.includes(C.id)) {
                itemRequests.push({ url: u, status: res.status() });
            }
        });

        await page.goto(
            `${TARGET}/book-index?id=${C.id}&tab=collated&juan=${encodeURIComponent(C.sampleJuanFile)}`,
        );
        await expect(
            page.getByRole('heading', {
                name: eitherScript(C.sampleJuanCategory, C.sampleJuanCategorySimplified),
            }),
        ).toBeVisible({ timeout: 30_000 });

        expect(itemRequests.length, '没有发出任何 items 请求').toBeGreaterThan(0);

        // 所有请求都必须带当前版本号做 cache-bust——版本号分裂时这里会露馅
        const badVersion = itemRequests.filter((r) => !/[?&]v=[0-9a-f]{12}(&|$)/.test(r.url));
        expect(
            badVersion.map((r) => r.url),
            'items 请求缺少 ?v= 版本号（或格式不对），CDN 会返回陈旧内容',
        ).toEqual([]);

        // 允许 404 的两类「可选资源」——前端探测不到就降级，属设计内行为：
        //   lineage_graph.json —— 多数书没有版本传承图
        //   collated_edition/text/*.txt —— 原始 md 原文，全库仅约三分之一的书有
        const OPTIONAL = /lineage_graph\.json|\/collated_edition\/text\//;
        const failed = itemRequests.filter((r) => r.status >= 400 && !OPTIONAL.test(r.url));
        expect(
            failed.map((f) => `${f.status} ${f.url}`),
            '必需的 items 资源请求失败——多半是版本号或文件名错',
        ).toEqual([]);
    });
});
