/**
 * 阅读页 /read/<id>（N5b）：旧入口跳过来、卷号与地址双向同步、翻卷不整页刷新。
 *
 * 只在全栈站跑（静态站没有这条路由）；前端须 >= 0.10.0（新阅读器）。
 * 地址约定见 nextjs/src/lib/reader-route.ts：/read/<id>[/<key>][/<章>]，主版本不写 default。
 * 只认新结构数据（overview#307），文本迁移落地前整组自动跳过。
 */
import { test, expect, type Page } from '@playwright/test';
import { ANCHORS, TARGET } from '../fixtures/anchors';
import { SITE } from '../fixtures/site-profile';
import { requireNewTextData, requireUiVersion } from '../fixtures/preconditions';

const C = ANCHORS.collated;

/** 目录里的一章：按 data-rd-toc-key（章文件名）找，不按文字——文字是章名，随整理变 */
const tocItem = (page: Page, key: string) => page.getByRole('navigation', { name: '目录' }).locator(`[data-rd-toc-key="${key}"]`);

/** 詩序：Work，维基文库与 Kanripo 各一份全文 */
const SHIXU = 'd59f2ew0ctmo';

/**
 * 直齋卷一、卷二的正文锚点（档位 3：经典原文，不随整理变）。繁简两种写法都认。
 * 分类标题＋该卷首条书目解题里的一句——只锚地址写回了 juan 不够，正文得真是这一卷。
 */
const JUAN_TEXT = {
    '001': { category: /易類|易类/, text: /王弼輔嗣|王弼辅嗣/ },
    '002': { category: /書類|书类/, text: /孔安國傳|孔安国传/ },
} as const;

test.describe('阅读页', () => {
    test.skip(!SITE.fullstack, `${SITE.host} 是静态站，没有阅读页路由`);
    test.beforeEach(async ({ request }) => {
        await requireUiVersion(request, '0.28.1', '统一阅读器 TextReader');
        await requireNewTextData(request, C.id, '阅读页（新结构）');
    });

    test('旧入口保留卷号 308 到新地址，正文渲染出来', async ({ page }) => {
        await page.goto(`${TARGET}/book-index?id=${C.id}&tab=collated&juan=${encodeURIComponent(C.sampleJuanFile)}`);
        // 整理本的 juan 是短形式（004），不是内部文件路径 juan/004.json（overview#267 P2-5）
        await expect(page).toHaveURL(new RegExp(`/read/${C.id}/${C.sampleJuanFile.replace(/^juan\/|\.json$/g, '')}$`));
        await expect(page.getByText(/加载整理本|加載整理本/)).toBeHidden({ timeout: 30_000 });
        await expect(page.getByRole('heading', { name: new RegExp(`${C.sampleJuanCategory}|${C.sampleJuanCategorySimplified}`) }))
            .toBeVisible({ timeout: 30_000 });
    });

    test('不带 juan 进来自动选首卷并写回地址；翻卷改地址与标题、不整页刷新', async ({ page }) => {
        await page.goto(`${TARGET}/read/${C.id}`);
        await expect(page).toHaveURL(new RegExp(`/read/${C.id}/001$`), { timeout: 30_000 });
        // 地址写回了卷一，正文也得是卷一：分类标题与解题原文都在
        const main = page.getByRole('main');
        const j1 = JUAN_TEXT['001'];
        const j2 = JUAN_TEXT['002'];
        await expect(main.getByRole('heading', { name: j1.category }), '正文不是卷一（分类标题不对）').toBeVisible({ timeout: 30_000 });
        await expect(main.getByText(j1.text).first(), '卷一正文没有渲染出实际文字').toBeVisible();

        await page.evaluate(() => { (window as unknown as { __n5b: number }).__n5b = 1; });
        await tocItem(page, '002').click({ timeout: 30_000 });
        await expect(page).toHaveURL(new RegExp(`/read/${C.id}/002$`));
        // <title> 带书名与章名，不带「整理本」等类别词（用户 10-01 定：统一叫「文本」；默认版本不写版本名）
        await expect(page).toHaveTitle(new RegExp(C.title));
        await expect(page).not.toHaveTitle(/整理本|转录全文|全文/);
        // 翻到卷二后正文跟着换：卷二的文字出现，卷一的不再显示
        await expect(main.getByRole('heading', { name: j2.category }), '翻卷后正文不是卷二').toBeVisible({ timeout: 30_000 });
        await expect(main.getByText(j2.text).first(), '卷二正文没有渲染出实际文字').toBeVisible();
        await expect(main.getByText(j1.text), '翻卷后还显示着卷一的正文').toHaveCount(0);
        expect(await page.evaluate(() => (window as unknown as { __n5b?: number }).__n5b), '翻卷触发了整页刷新').toBe(1);
    });

    test('翻卷后按浏览器返回，回到上一卷而不是离开阅读页（overview#267 P2-3）', async ({ page }) => {
        await page.goto(`${TARGET}/read/${C.id}`);
        await expect(page).toHaveURL(new RegExp(`/read/${C.id}/001$`), { timeout: 30_000 });
        const main = page.getByRole('main');
        const j1 = JUAN_TEXT['001'];
        await expect(main.getByText(j1.text).first()).toBeVisible({ timeout: 30_000 });

        await tocItem(page, '002').click({ timeout: 30_000 });
        await expect(page).toHaveURL(new RegExp(`/read/${C.id}/002$`));

        await page.goBack();
        await expect(page, '返回应回到卷一，仍在阅读页').toHaveURL(new RegExp(`/read/${C.id}/001$`));
        await expect(main.getByText(j1.text).first(), '返回后正文应换回卷一').toBeVisible({ timeout: 30_000 });
    });

    test('Work 全文有两份时可来回切换版本：地址里的版本 key 变、出处与授权跟着变', async ({ page, request }) => {
        await requireNewTextData(request, SHIXU, '版本下拉框（詩序）');
        // 詩序：维基文库与 Kanripo 两份全文（overview#235）
        await page.goto(`${TARGET}/read/${SHIXU}`);
        const select = page.getByRole('combobox', { name: '版本' });
        await expect(select, '两份全文应出版本下拉框').toBeVisible({ timeout: 30_000 });
        const keys = await select.locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
        expect(keys.length, '詩序应有维基与 Kanripo 两份全文').toBeGreaterThanOrEqual(2);

        // 出处那一行（“来源 …·授权”）在正文标题下，取它随版本变化的整段文字
        const sourceLine = page.locator('.bim-rd-meta').first();
        await expect(sourceLine).toContainText(/来源|來源/, { timeout: 30_000 });
        const first = await select.inputValue();
        const firstText = await sourceLine.innerText();

        const other = keys.find((k) => k !== first)!;
        await page.evaluate(() => { (window as unknown as { __w5: number }).__w5 = 1; });
        await select.selectOption(other);
        await expect(page).toHaveURL(new RegExp(`/read/${SHIXU}/${other}(/|$)`));
        await expect(sourceLine, '出处与授权应跟着所选版本变').not.toHaveText(firstText, { timeout: 30_000 });
        const otherText = await sourceLine.innerText();
        expect(otherText, '授权文字缺失').toMatch(/CC|公[有共]|Public|授权|授權|许可|許可|licen/i);

        // 切回去，出处回到第一份的
        await select.selectOption(first);
        await expect(page).toHaveURL(first === 'default' ? new RegExp(`/read/${SHIXU}(/\\d+)?$`) : new RegExp(`/read/${SHIXU}/${first}(/|$)`));
        await expect(sourceLine).toHaveText(firstText, { timeout: 30_000 });
        expect(await page.evaluate(() => (window as unknown as { __w5?: number }).__w5), '换版本触发了整页刷新').toBe(1);
    });
});
