/**
 * 版本对校（A41）：阅读页 `?cmp=<条目id>[-<版本key>]`，浏览器现场比对底本与对照本，正文上按类别色标出差异。
 *
 * 用例以四庫總目为准：底本＝自校本 Book 96mid1ogzk 第 2 册（卷一至卷三），
 * 对照本＝维基文庫（Work d59dh3vo9af4 的 wikisource 版本），以及本书另一个版本光盘本（wyg-cd）。
 * 只看用户看得到的东西：来源行的「對校」按钮、底部计数条、正文上的标记、点开的详情卡、退出对校。
 * 只在全栈站跑；对校插件没上线（来源行没有按钮）时整组跳过。
 */
import { test, expect, type Page } from '../fixtures/test';
import { TARGET } from '../fixtures/anchors';
import { SITE } from '../fixtures/site-profile';

const BOOK = '96mid1ogzk';
const WORK = 'd59dh3vo9af4';
const WIKI = `${WORK}-wikisource`;
const PATH = `${TARGET}/read/${BOOK}/002`;

const overlay = (page: Page) => page.getByTestId('compare-overlay');
/** 底部条上的各类计数（只列开着的类别） */
const counts = (page: Page) => overlay(page).locator('.cmp-count');
/** 正文上带对校标记的字 */
const marks = (page: Page) => page.locator('.guji-text-char[data-cd-custom]');

async function waitText(page: Page) {
    await expect(page.locator('.guji-text-char').first()).toBeVisible({ timeout: 60_000 });
}

async function waitCompared(page: Page) {
    // 比对要先取对照本几卷的 md 与异体字表，再现场算；给足时间
    await expect(counts(page).first()).toBeVisible({ timeout: 60_000 });
}

test.describe('版本对校', () => {
    test.skip(!SITE.fullstack, `${SITE.host} 是静态站，没有阅读页路由`);

    test('来源行点「對校」：网址带上 cmp，出计数条与正文标记', async ({ page }) => {
        await page.goto(PATH);
        await waitText(page);
        const btn = page.getByTestId('compare-button').first();
        test.skip(!(await btn.isVisible().catch(() => false)), '来源行没有「對校」按钮（对校插件未上线）');
        await btn.click();
        // 按钮只给条目 id，网址里补上该条目的主版本 key
        await expect(page).toHaveURL(new RegExp(`[?&]cmp=${WORK}(-[a-z0-9-]+)?$`));
        await waitCompared(page);
        await expect(btn).toHaveAttribute('aria-pressed', 'true');
        await expect.poll(() => marks(page).count(), { timeout: 15_000 }).toBeGreaterThan(10);
    });

    test('直接打开对校网址：默认不显示异体字，计数与标记都在', async ({ page }) => {
        await page.goto(`${PATH}?cmp=${WIKI}`);
        await waitText(page);
        await waitCompared(page);
        // 默认开的类别：用字不同、对照本多、对照本少；异体字默认关
        const labels = await counts(page).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
        expect(labels.some((l) => /異體|异体/.test(l))).toBe(false);
        const total = (await counts(page).allTextContents()).reduce((s, t) => s + Number(t || 0), 0);
        expect(total).toBeGreaterThan(10);
        await expect.poll(() => marks(page).count(), { timeout: 15_000 }).toBeGreaterThan(0);
    });

    test('「下一處」打开详情卡，显示底本与对照本两段上下文；×关卡，「退出對校」去掉参数', async ({ page }) => {
        await page.goto(`${PATH}?cmp=${WIKI}`);
        await waitText(page);
        await waitCompared(page);
        await overlay(page).getByRole('button', { name: /下一[處处]/ }).click();
        const card = page.getByTestId('compare-detail');
        await expect(card).toBeVisible();
        await expect(card).toContainText(/底本/);
        await expect(card).toContainText(/對照本|对照本/);
        await expect(overlay(page).locator('.cmp-bar-pos')).toHaveText(/^1\/\d+$/);
        await overlay(page).getByRole('button', { name: /下一[處处]/ }).click();
        await expect(overlay(page).locator('.cmp-bar-pos')).toHaveText(/^2\/\d+$/);
        await card.getByRole('button', { name: /關閉|关闭/ }).click();
        await expect(card).toBeHidden();
        await overlay(page).getByRole('button', { name: /退出[對对][校]/ }).click();
        await expect(page).not.toHaveURL(/[?&]cmp=/);
        await expect(overlay(page)).toHaveCount(0);
        await expect(marks(page)).toHaveCount(0);
    });

    test('点正文上有标记的字出详情卡', async ({ page }) => {
        await page.goto(`${PATH}?cmp=${WIKI}`);
        await waitText(page);
        await waitCompared(page);
        const m = marks(page).first();
        await m.scrollIntoViewIfNeeded();
        await m.click();
        await expect(page.getByTestId('compare-detail')).toBeVisible();
    });

    test('对照本是本书另一个版本（光盘本）', async ({ page }) => {
        await page.goto(`${PATH}?cmp=${BOOK}-wyg-cd`);
        await waitText(page);
        await waitCompared(page);
        await expect(page.getByTestId('compare-sibling-button').first()).toHaveAttribute('aria-pressed', 'true');
    });

    test('参数不合法：静默忽略，按普通阅读页显示', async ({ page }) => {
        await page.goto(`${PATH}?cmp=zzzzzzzzzzzz-nope`);
        await waitText(page);
        await page.waitForTimeout(3_000);
        await expect(overlay(page)).toHaveCount(0);
        await expect(marks(page)).toHaveCount(0);
    });
});
