/**
 * 图文对读 /read/96mid1ogzk/original/003（四庫總目 vol03，overview#421）：点字高亮书影、滚动翻页、悬停专名出摘要卡并跳条目。
 *
 * 只在全栈站跑；前端须 >= 对读版 book-index-ui。
 * 数据（新结构文本，章条目声明 char_file／cord_file，对应 003.char.json、003.cord.json 等）没上线时整组跳过。
 * 书影来自 data.kaiyuanguji.com 的 IIIF（overview#388），页序见 cord 每页的 canvas（overview#425）。
 */
import { test, expect, type Page } from '../fixtures/test';
import { TARGET } from '../fixtures/anchors';
import { SITE } from '../fixtures/site-profile';
import { requireNewTextData, requireTextFile, requireUiVersion } from '../fixtures/preconditions';

const BOOK = '96mid1ogzk';
const PATH = `${TARGET}/read/${BOOK}/original/003`;
/** 带书影翻页／缩放（overview#425）的 book-index-ui 版本；bim 实际发版号定了以后核对这里 */
const MIN_UI = '0.45.0';
/** 标点 pos=before 修复所在的 book-index-ui 版本（bim#124 发版后核对） */
const FIX_POS_UI = '0.45.1';

/** 当前书影页（书影区标牌「第 N 葉」上的 data-warp-page） */
const warpPage = (page: Page) => page.locator('[data-warp-page]').first();

async function openDuidu(page: Page) {
    await page.goto(PATH);
    await expect(page.locator('[data-char-id]').first()).toBeVisible({ timeout: 60_000 });
    // 专名线默认关；对读正文的实体标注跟着它走
    const toggle = page.getByRole('button', { name: /专名线|專名線/ });
    if ((await toggle.getAttribute('aria-pressed')) !== 'true') await toggle.click();
}

test.describe('图文对读（vol03）', () => {
    test.skip(!SITE.fullstack, `${SITE.host} 是静态站，没有阅读页路由`);
    test.beforeEach(async ({ request }) => {
        await requireUiVersion(request, MIN_UI, '图文对读');
        await requireNewTextData(request, BOOK, '图文对读（新结构文本）');
        // 对读与否看数据层上有没有这章的 cord（线上文本在 h1 哈希寻址里，不能读站内 /data/items/...）
        await requireTextFile(request, BOOK, 'original/003.cord.json', '图文对读（003 的 cord）');
    });

    test('点字：书影上出现高亮框，书影页＝该字所在页', async ({ page }) => {
        await openDuidu(page);
        const ch = page.locator('[data-char-id^="20:"]').first();
        await ch.scrollIntoViewIfNeeded();
        await ch.click();
        await expect(warpPage(page)).toHaveAttribute('data-warp-page', '20');
        await expect(page.locator('svg rect[data-selected="true"]').first()).toBeVisible();
    });

    test('正文滚到下一页，书影页码跟着变', async ({ page }) => {
        await openDuidu(page);
        const before = Number(await warpPage(page).getAttribute('data-warp-page'));
        const target = page.locator(`[data-char-id^="${before + 3}:"]`).first();
        await target.scrollIntoViewIfNeeded();
        await expect.poll(async () => Number(await warpPage(page).getAttribute('data-warp-page')), { timeout: 15_000 })
            .toBeGreaterThan(before);
    });

    test('书影翻页按钮：翻一页，书影页码加一，正文滚到该页开头', async ({ page }) => {
        await openDuidu(page);
        const before = Number(await warpPage(page).getAttribute('data-warp-page'));
        await page.getByTestId('facsimile-next').click();
        await expect(warpPage(page)).toHaveAttribute('data-warp-page', String(before + 1));
        // 该页的正文段落顶边在视口上部（页首已被滚到参考线上方不远处），而不是只改了书影
        await expect.poll(async () => page.locator(`[data-page-section="${before + 1}"]`).evaluate((el) => {
            const top = el.getBoundingClientRect().top;
            return top >= -2 && top <= 200;
        }), { timeout: 10_000 }).toBe(true);
        // 反方向
        await page.getByTestId('facsimile-prev').click();
        await expect(warpPage(page)).toHaveAttribute('data-warp-page', String(before));
    });

    test('键盘翻页只在书影区聚焦时响应，正文区的方向键不翻页', async ({ page }) => {
        await openDuidu(page);
        const before = Number(await warpPage(page).getAttribute('data-warp-page'));
        await page.locator('[data-char-id]').first().click();
        await page.keyboard.press('ArrowRight');
        await expect(warpPage(page)).toHaveAttribute('data-warp-page', String(before));
        await page.getByTestId('facsimile-panel').focus();
        await page.keyboard.press('ArrowRight');
        await expect(warpPage(page)).toHaveAttribute('data-warp-page', String(before + 1));
        await page.keyboard.press('ArrowLeft');
        await expect(warpPage(page)).toHaveAttribute('data-warp-page', String(before));
    });

    test('滚轮缩放后：拖动不选字，点字框仍能定位正文；双击复位', async ({ page }) => {
        await openDuidu(page);
        const box = page.locator('.bim-zp');
        await expect(box).toHaveAttribute('data-zoom', '1.00');
        const b = (await box.boundingBox())!;
        const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
        await page.mouse.move(cx, cy);
        await page.mouse.wheel(0, -600);
        await expect.poll(async () => Number(await box.getAttribute('data-zoom'))).toBeGreaterThan(1.5);
        // 拖动：平移，不触发选字
        await page.mouse.down();
        await page.mouse.move(cx - 60, cy - 40, { steps: 6 });
        await page.mouse.up();
        await expect(page.locator('svg rect[data-selected="true"]')).toHaveCount(0);
        // 点一个落在书影区内的字框 → 选中并定位正文
        const pt = await page.evaluate(() => {
            const area = document.querySelector('.bim-zp')!.getBoundingClientRect();
            for (const r of Array.from(document.querySelectorAll('.bim-zp svg rect'))) {
                const q = r.getBoundingClientRect();
                const x = q.x + q.width / 2, y = q.y + q.height / 2;
                if (q.width > 4 && x > area.x + 10 && x < area.right - 10 && y > area.y + 10 && y < area.bottom - 10) return { x, y };
            }
            return null;
        });
        expect(pt).not.toBeNull();
        await page.mouse.click(pt!.x, pt!.y);
        await expect(page.locator('svg rect[data-selected="true"]').first()).toBeVisible();
        await expect(page.locator('.guji-text-char.is-selected').first()).toBeVisible();
        // 双击复位
        await page.mouse.dblclick(cx, cy);
        await expect(box).toHaveAttribute('data-zoom', '1.00');
    });

    test('书影来自 data.kaiyuanguji.com，不读站内 /facsimiles/', async ({ page }) => {
        const imgs: string[] = [];
        page.on('request', (r) => { if (r.resourceType() === 'image') imgs.push(r.url()); });
        await openDuidu(page);
        await expect.poll(() => imgs.some((u) => u.includes('data.kaiyuanguji.com/iiif/'))).toBe(true);
        expect(imgs.filter((u) => u.includes('/facsimiles/'))).toEqual([]);
    });

    test('悬停已收录的专名出摘要卡；点字只高亮不跳，Ctrl 点击才进条目页', async ({ page }) => {
        await openDuidu(page);
        const link = page.locator('a.bim-et[href^="/item/"]').first();
        await link.scrollIntoViewIfNeeded();
        await link.hover();
        await expect(page.getByRole('tooltip')).toBeVisible();
        const href = await link.getAttribute('href');
        // 点专名里的字：照常点字，留在阅读页
        await link.locator('[data-char-id]').first().click();
        await expect(page).toHaveURL(PATH);
        await expect(warpPage(page)).toBeVisible();
        // Ctrl 点击进条目页
        await link.locator('[data-char-id]').first().click({ modifiers: ['Control'] });
        await expect(page).toHaveURL(new RegExp(`${href}$`), { timeout: 15_000 });
    });

    test('合扫拆页 105–110：逐页点字，书影页码对、字框出现、画面是该页自己的 canvas', async ({ page }) => {
        await openDuidu(page);
        const seen: string[] = [];
        page.on('request', (r) => { const m = r.url().match(/iiif\/96mid1ogzk\/03\/(\d{4}[a-d]?)\/full/); if (m) seen.push(m[1]); });
        for (const pg of [105, 106, 107, 108, 109, 110]) {
            const ch = page.locator(`[data-char-id^="${pg}:5:"]`).first();
            await ch.scrollIntoViewIfNeeded();
            await ch.click();
            await expect(warpPage(page)).toHaveAttribute('data-warp-page', String(pg));
            await expect(page.locator('svg rect[data-selected="true"]').first()).toBeVisible();
        }
        // 105–108 → 0105a–d，109、110 → 0106、0107（页号顺延，画面按 cord 的 canvas 取）
        for (const id of ['0105a', '0105b', '0105c', '0105d', '0106', '0107']) expect(seen).toContain(id);
    });

    test('第 1、2 页（书脊签、封面签条）没有字：正文不出现这两页', async ({ page }) => {
        await openDuidu(page);
        await expect(page.locator('[data-page-section="1"]')).toHaveCount(0);
        await expect(page.locator('[data-page-section="2"]')).toHaveCount(0);
        await expect(page.locator('[data-char-id^="1:"], [data-char-id^="2:"]')).toHaveCount(0);
        // 对读从第 3 页起
        expect(Number(await warpPage(page).getAttribute('data-warp-page'))).toBe(3);
    });

    test('繁简切换：对读正文跟着转，锚点不变', async ({ page }) => {
        await openDuidu(page);
        const para = () => page.locator('[data-char-id="4:1:5"]').evaluate((e) => e.textContent);
        expect(await para()).toBe('时');
        await page.getByRole('button', { name: /切換為繁體/ }).click();
        await expect.poll(para).toBe('時');
        await expect(page.locator('[data-char-id="4:1:5"]')).toHaveCount(1);
    });

    test('标点开关：关掉后没有标点，打开后回来', async ({ page }) => {
        await openDuidu(page);
        const punct = page.locator('.guji-text-punct');
        await expect.poll(() => punct.count()).toBeGreaterThan(100);
        const btn = page.locator('button[title="切换外挂现代断句标点"]');
        await btn.click();
        await expect(punct).toHaveCount(0);
        await btn.click();
        await expect.poll(() => punct.count()).toBeGreaterThan(100);
    });

    test('专名线：人名单线、地名双线、书名波浪线', async ({ page }) => {
        await openDuidu(page);
        const style = (cls: string) => page.locator(`.bim-et-${cls}`).first().evaluate((e) => {
            const cs = getComputedStyle(e);
            return `${cs.textDecorationLine}/${cs.textDecorationStyle}`;
        });
        await expect.poll(() => style('person')).toBe('underline/solid');
        await expect.poll(() => style('place')).toBe('underline/double');
        await expect.poll(() => style('work')).toBe('underline/wavy');
    });

    test('书名号位置：《 在书名第一个字之前，单字书名《彖》不是「彖《》」', async ({ page, request }) => {
        // 标点 pos=before 的修复（bim PR #124）发版后才有；版本号以实际发版为准
        await requireUiVersion(request, FIX_POS_UI, '标点 pos=before');
        await openDuidu(page);
        // 4:1:17 彖 的标点：《 pos=before、》 pos=after（003.punct.json）
        const para = await page.locator('[data-char-id="4:1:17"]').evaluate((e) => e.closest('p')!.textContent ?? '');
        expect(para).toContain('孔子《彖》、《象》传');
        expect(para).toContain('元苏天爵《文类》，明刘昌《中州文表》');
        // 3:6:14–15「元史」整词书名，《 在首字之前
        const p3 = await page.locator('[data-char-id="3:6:14"]').evaluate((e) => e.closest('p')!.textContent ?? '');
        expect(p3).toContain('具《元史》本传');
    });
});
