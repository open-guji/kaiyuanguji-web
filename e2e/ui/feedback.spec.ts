/**
 * 反馈入口（N7，overview#260）：导航栏「反馈」、条目页「这条有误？」、阅读页选字「报错」。
 *
 * `/api/feedback` 一律拦下来 mock，不向任何站点提交：正式站与测试站共用正式的 KV，
 * 真提交一条就是一条混进用户反馈里的垃圾数据。拦截挂在 context 上，先于页面任何请求生效，
 * 同一 context 里的页面、弹窗发出的反馈请求都会被它接住。
 *
 * 站点还没上线 N7（顶栏没有「反馈」按钮）时整组跳过，上线后自动生效。
 */
import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { ANCHORS, TARGET } from '../fixtures/anchors';
import { SITE } from '../fixtures/site-profile';

const WORK = ANCHORS.work.id;
const C = ANCHORS.collated;
/** 阅读页地址里的整理本卷号是短形式（juan/004.json → 004），见 lib/reader-route.ts */
const JUAN = C.sampleJuanFile.replace(/^juan\/|\.json$/g, '');

interface Captured {
    posts: Record<string, unknown>[];
}

/** 拦下所有 /api/feedback：GET 给一条示意数据，POST 记下请求体后回成功 */
async function mockFeedbackApi(context: BrowserContext): Promise<Captured> {
    const captured: Captured = { posts: [] };
    await context.route('**/api/feedback**', async (route) => {
        const req = route.request();
        if (req.method() === 'POST') {
            captured.posts.push(req.postDataJSON());
            await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, id: 'fb_e2e' }) });
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                success: true,
                items: [{ id: 'fb_demo', type: 'suggestion', content: '（e2e 示意数据）', createdAt: '2026-09-28T00:00:00Z', status: 'pending' }],
            }),
        });
    });
    return captured;
}

async function requireN7(page: Page) {
    const n = await page.locator('header').getByRole('button', { name: '反馈' }).count();
    test.skip(n === 0, `${SITE.host} 顶栏还没有「反馈」按钮（N7 未上线）`);
}

async function fillAndSubmit(page: Page, text: string) {
    const dialog = page.getByRole('dialog', { name: '反馈' });
    await dialog.getByRole('textbox', { name: '反馈内容' }).fill(text);
    await dialog.getByRole('button', { name: '提交' }).click();
    await expect(dialog.getByRole('status')).toContainText('已经收到');
}

test.describe('反馈入口（N7）', () => {
    let captured: Captured;

    test.beforeEach(async ({ context }) => {
        captured = await mockFeedbackApi(context);
    });

    test('首页：没有右下角浮钮，顶栏「反馈」打开弹窗，提交不带条目', async ({ page }) => {
        await page.goto(`${TARGET}/`);
        await requireN7(page);
        // 全页只有顶栏这一个「反馈」按钮（旧浮钮也叫「反馈」，它在就会是 2 个）
        await expect(page.getByRole('button', { name: '反馈', exact: true })).toHaveCount(1);

        await page.locator('header').getByRole('button', { name: '反馈' }).click();
        const dialog = page.getByRole('dialog', { name: '反馈' });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole('radio', { name: '功能建议' })).toHaveAttribute('aria-checked', 'true');
        await expect(dialog.getByText('关于', { exact: true })).toHaveCount(0);

        await fillAndSubmit(page, 'e2e：首页提交');
        expect(captured.posts).toHaveLength(1);
        expect(captured.posts[0]).toMatchObject({ type: 'suggestion', content: 'e2e：首页提交', resourceId: '' });
        expect(String(captured.posts[0].pageUrl)).toMatch(/\/$/);
    });

    test('Esc 关闭弹窗，焦点回到顶栏「反馈」', async ({ page }) => {
        await page.goto(`${TARGET}/`);
        await requireN7(page);
        const fb = page.locator('header').getByRole('button', { name: '反馈' });
        await fb.click();
        await expect(page.getByRole('dialog', { name: '反馈' })).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog', { name: '反馈' })).toHaveCount(0);
        await expect(fb).toBeFocused();
    });

    test('条目页：「这条有误？」带上条目 id', async ({ page }) => {
        await page.goto(SITE.fullstack ? `${TARGET}/item/${WORK}` : `${TARGET}/book-index?id=${WORK}`);
        await requireN7(page);
        const report = page.getByRole('button', { name: '这条有误？' });
        await expect(report).toBeVisible({ timeout: 30_000 });
        await report.click();

        const dialog = page.getByRole('dialog', { name: '反馈' });
        await expect(dialog.getByText(new RegExp(WORK))).toBeVisible();
        await expect(dialog.getByRole('radio', { name: '内容有误' })).toHaveAttribute('aria-checked', 'true');

        await fillAndSubmit(page, 'e2e：条目页报错');
        expect(captured.posts[0]).toMatchObject({ type: 'bug', content: 'e2e：条目页报错', resourceId: WORK });
    });

    test('阅读页：选中文字「报错」，选中的文字拼在正文开头，卷号随 pageUrl', async ({ page }) => {
        test.skip(!SITE.fullstack, `${SITE.host} 是静态站，没有阅读页路由`);
        await page.goto(`${TARGET}/read/${C.id}?kind=collated&juan=${JUAN}`);
        await requireN7(page);
        await expect(page.getByRole('heading', { name: new RegExp(`${C.sampleJuanCategory}|${C.sampleJuanCategorySimplified}`) }))
            .toBeVisible({ timeout: 30_000 });

        // 选中正文里第一段长文字的前 8 个字（阅读器把自己的样式表插在正文容器里，要跳过 <style>）
        const picked = await page.evaluate(() => {
            const main = document.querySelector('main')!;
            const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT, {
                acceptNode: (n) => ((n.textContent ?? '').trim().length > 20 && !n.parentElement?.closest('style, script, template, button, input, header, nav')
                    ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
            });
            const node = walker.nextNode()!;
            const start = (node.textContent ?? '').search(/\S/);
            const range = document.createRange();
            range.setStart(node, start);
            range.setEnd(node, start + 8);
            const sel = window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(range);
            return sel.toString().trim();
        });

        const bar = page.getByRole('toolbar', { name: '选中文字' });
        await expect(bar).toBeVisible();
        await bar.getByRole('button', { name: '报错' }).click();

        const dialog = page.getByRole('dialog', { name: '反馈' });
        await expect(dialog.getByText(picked, { exact: true })).toBeVisible();

        await fillAndSubmit(page, 'e2e：阅读页报错');
        const body = captured.posts[0];
        expect(body).toMatchObject({ type: 'bug', resourceId: C.id });
        expect(String(body.content)).toBe(`【原文】${picked.replace(/\s+/g, ' ')}\n\ne2e：阅读页报错`);
        expect(String(body.pageUrl)).toMatch(new RegExp(`[?&]juan=${JUAN}(&|$)`));
    });

    test('阅读页：右栏「报告错字」打开反馈，带上条目 id、卷、位置锚点（v4 P2，overview#299）', async ({ page }) => {
        test.skip(!SITE.fullstack, `${SITE.host} 是静态站，没有阅读页路由`);
        await page.setViewportSize({ width: 1440, height: 900 }); // 右栏 ≥860px 才显示
        await page.goto(`${TARGET}/read/${C.id}?kind=collated&juan=${JUAN}`);
        await requireN7(page);
        const report = page.getByRole('button', { name: '报告错字' });
        // 站点还没升到带「报告错字」的 book-index-ui（≥0.28）时整条跳过
        await report.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {});
        test.skip((await report.count()) === 0, `${SITE.host} 的阅读器还没有「报告错字」（book-index-ui < 0.28）`);

        await report.click();
        const dialog = page.getByRole('dialog', { name: '反馈' });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole('radio', { name: '内容有误' })).toHaveAttribute('aria-checked', 'true');
        // 「关于」一行是「书名 · 整理本 · 卷N」（不含条目 id；id 在下面的提交体 resourceId 里断言）
        await expect(dialog.getByText(new RegExp(`整理本 · 卷${Number(JUAN)}`))).toBeVisible();

        await fillAndSubmit(page, 'e2e：报告错字');
        const body = captured.posts[0];
        expect(body).toMatchObject({ type: 'bug', resourceId: C.id });
        expect(String(body.content)).toBe('e2e：报告错字'); // 没选字就没有【原文】
        expect(String(body.pageUrl)).toMatch(new RegExp(`[?&]juan=${JUAN}(&|#|$)`));
    });

    test('/feedback：「写反馈」打开弹窗', async ({ page }) => {
        await page.goto(`${TARGET}/feedback`);
        await requireN7(page);
        await expect(page.getByText('（e2e 示意数据）')).toBeVisible();
        await page.getByRole('button', { name: '写反馈' }).click();
        await expect(page.getByRole('dialog', { name: '反馈' })).toBeVisible();
    });

    test.describe('手机 390 宽', () => {
        test.use({ viewport: { width: 390, height: 844 } });

        test('顶栏「反馈」只剩图标、不小于 44×44，弹窗贴底', async ({ page }) => {
            await page.goto(`${TARGET}/`);
            await requireN7(page);
            const fb = page.locator('header').getByRole('button', { name: '反馈' });
            await expect(fb).toBeVisible();
            const box = (await fb.boundingBox())!;
            expect(box.width).toBeGreaterThanOrEqual(44);
            expect(box.height).toBeGreaterThanOrEqual(44);
            await expect(fb.locator('.og-nav-fb-label')).toBeHidden();

            await fb.click();
            const dialog = page.getByRole('dialog', { name: '反馈' });
            await expect(dialog).toBeVisible();
            const d = (await dialog.boundingBox())!;
            expect(Math.round(d.y + d.height)).toBeGreaterThanOrEqual(844 - 1);
            expect(Math.round(d.width)).toBe(390);
        });
    });
});
