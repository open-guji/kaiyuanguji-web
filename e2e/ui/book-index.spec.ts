/**
 * 索引页与详情页渲染。
 *
 * 除了"页面能打开"，重点验证数据真的渲染出来了——本次多个 bug 的共同特征
 * 就是：HTTP 全 200、无 pageerror、字节数正常，但内容是空的或错的。
 */
import { test, expect } from '@playwright/test';
import { ANCHORS, BOOK_INDEX_TABS, TARGET } from '../fixtures/anchors';

function eitherScript(traditional: string, simplified: string): RegExp {
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`${esc(traditional)}|${esc(simplified)}`);
}

test.describe('首页', () => {
    test('正常加载且导航完整', async ({ page }) => {
        await page.goto(TARGET);
        // 搜索入口原名「古籍索引」→「古籍元数据」（overview#267）→ 顶栏简称「元数据」（9-30 反馈，overview#322）
        await expect(page.getByRole('link', { name: '元数据', exact: true }).first()).toBeVisible();
        await expect(page.getByRole('link', { name: '古籍索引' })).toHaveCount(0);
    });

    // N1 首页：大检索框 + 唯一主按钮「搜索」，搜索落到索引页
    test('首屏检索跳到索引页', async ({ page }) => {
        await page.goto(TARGET);
        await page.getByRole('searchbox', { name: '搜索古籍索引' }).fill('史記');
        await page.getByRole('button', { name: '搜索', exact: true }).click();
        await expect(page).toHaveURL(/\/book-index\?q=/);
    });

    test('写明 CC0', async ({ page }) => {
        await page.goto(TARGET);
        await expect(page.getByText(/CC0 公有领域/).first()).toBeVisible();
    });

    // 用户意见（overview#267）：搜索框下面只有三个例子，史记→作品页、四库全书→丛编页、红楼梦程甲本→阅读页（09-30 用户重申）
    test('搜索框下面只有三个例子，没有「看一个例子」', async ({ page }) => {
        await page.goto(TARGET);
        const under = page.locator('.home-under');
        await expect(under.getByRole('link')).toHaveText(['史记', '四库全书', '红楼梦程甲本']);
        await expect(under.getByRole('link').nth(0)).toHaveAttribute('href', '/item/d59f20aowb9c');
        await expect(under.getByRole('link').nth(1)).toHaveAttribute('href', '/item/8rlb6yi1ecqo');
        await expect(under.getByRole('link').nth(2)).toHaveAttribute('href', '/read/96kzkdm8e8');
        await expect(page.getByText(/看一个例子/)).toHaveCount(0);
    });

    test('「我们在做的事」六项标题；「一起把古籍做成开放数据」已删；页脚是黑底、没有开放协议一栏', async ({ page }) => {
        await page.goto(TARGET);
        await expect(page.locator('.home-feature h3')).toHaveText([
            /^古籍元数据/, /^资源收集/, /^图文对读/, /^全文检索/, /^协同校对/, /^古籍专用模型/,
        ]);
        await expect(page.getByText('一起把古籍做成开放数据')).toHaveCount(0);
        const footer = page.getByRole('contentinfo');
        await expect(footer).toBeVisible();
        await expect(footer).not.toContainText('开放协议');
        // 页脚底色用墨色令牌 --color-ink（rgb(38, 33, 28)），不再是浅色
        const bg = await footer.evaluate((el) => getComputedStyle(el).backgroundColor);
        expect(bg).toBe('rgb(38, 33, 28)');
    });

    for (const width of [390, 360]) {
        test(`手机 ${width}px 不横向溢出`, async ({ page }) => {
            await page.setViewportSize({ width, height: 800 });
            await page.goto(TARGET);
            await expect(page.getByRole('searchbox', { name: '搜索古籍索引' })).toBeVisible();
            const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
            expect(scrollWidth, '页面出现横向滚动').toBeLessThanOrEqual(width);
        });
    }
});

test.describe('古籍索引页', () => {
    test('默认页显示全局统计', async ({ page }) => {
        await page.goto(`${TARGET}/book-index`);

        // 统计数字来自 meta.json；显示 0 或不显示 = 数据没加载上
        await expect(page.getByText(/[\d,]+\s*本/).first()).toBeVisible({ timeout: 30_000 });
        await expect(page.getByRole('heading', { name: /古籍资源索引|古籍資源索引/ })).toBeVisible();
    });

    for (const tab of BOOK_INDEX_TABS) {
        test(`tab=${tab} 可打开且无 JS 错误`, async ({ page }) => {
            const errors: string[] = [];
            page.on('pageerror', (e) => errors.push(e.message));

            await page.goto(`${TARGET}/book-index?tab=${tab}`);
            await expect(page.locator('main')).toBeVisible({ timeout: 30_000 });

            expect(errors, `tab=${tab} 出现 JS 异常`).toEqual([]);
        });
    }
});

test.describe('作品详情', () => {
    const W = ANCHORS.work;

    test('渲染标题、作者与关联区块', async ({ page }) => {
        await page.goto(`${TARGET}/book-index?id=${W.id}`);

        await expect(
            page.getByRole('heading', { name: eitherScript(W.title, W.titleSimplified) }).first(),
        ).toBeVisible({ timeout: 30_000 });

        await expect(
            page.getByText(eitherScript(W.author, W.authorSimplified)).first(),
            '作者未渲染',
        ).toBeVisible();

        // 版本区块——史記有 35 个版本，为空说明 books 关联没渲染。
        // 0.10.0 三栏版的区块标题是「版本」，之前是「相关版本」
        await expect(
            page.getByText(/相关版本|相關版本/).or(page.getByRole('heading', { name: /^版本$/ })).first(),
            '缺版本区块',
        ).toBeVisible();
    });

    /**
     * 旧 draft ID 不再跳转 —— 2026-09-14 起的方针，本用例随之改向。
     *
     * 原用例断言 draft→production 自动跳转（promotions.json 驱动）。
     * book-index-draft 的 `1391e7a917f`「清空 promotions.json：不再永久支持
     * 舊 draft id 跳轉」把 140,177 条对照尽数删去，只留空表 `{"version":1,
     * "promotions":{}}`。该提交明写：**「代價已知並接受：外部收藏或搜索引擎
     * 收錄之舊 draft id 連結自此 404」**——所以这是既定方针，不是回归。
     *
     * 留空档而不删档是有意的（见该提交）：bundle-data.mjs 以 existsSync 决定
     * 是否复制，删档会让客户端走 404 分支；留空档则 fetch 得 200 空表，
     * ensurePromotions() 回空 Map，行为确定。
     *
     * 所以这里改为守「降级得体面」：旧 draft ID 必须给出友好提示，
     * 不能白屏、不能 JS 报错。真正该守的底线是这个，而不是跳转本身。
     *
     * 若日后要恢复跳转（对照表可从 git 史或 D:\data\book-index-draft-backup-20260914
     * 取回并固化进产物），把本用例改回断言 toHaveURL(/id=d59f20aowb9c/) 即可。
     */
    test('旧草稿 ID 给出友好提示而非白屏（跳转已按方针取消）', async ({ page }) => {
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(e.message));

        await page.goto(`${TARGET}/book-index?id=1eujfe7s94veo`);
        await expect(
            page.getByText(/找不到|不存在|已被删除|已被刪除/).first(),
            '旧 draft ID 既不跳转也不给提示——这才是真回归',
        ).toBeVisible({ timeout: 30_000 });
        expect(errors, `页面 JS 报错：${errors.join('; ')}`).toEqual([]);
    });

    test('不存在的 ID 给出友好提示而非白屏', async ({ page }) => {
        await page.goto(`${TARGET}/book-index?id=nonexistent000`);
        await expect(
            page.getByText(/找不到|不存在|已被删除|已被刪除/).first(),
        ).toBeVisible({ timeout: 30_000 });
    });
});

test.describe('实体详情', () => {
    test('人物页可打开', async ({ page }) => {
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(e.message));

        await page.goto(`${TARGET}/book-index?id=${ANCHORS.entity.id}`);
        await expect(page.locator('main')).toBeVisible({ timeout: 30_000 });
        expect(errors).toEqual([]);
    });
});

test.describe('数据版本标识', () => {
    test('页面显示的版本与线上发布版本一致', async ({ page, request }) => {
        // 2026-09-02：版本条读 current/version.json（immutable 长缓存），
        // 显示的 commit 落后 9 天。这既误导排查，也是版本号分裂的信号。
        const latestRes = await request.get(`https://data.kaiyuanguji.com/latest.json?_=${Date.now()}`);
        const latest = await latestRes.json();
        const shortId = String(latest.commitId).slice(0, 7);

        await page.goto(`${TARGET}/book-index`);
        await expect(
            page.getByText(new RegExp(`数据版本[:：]\\s*${shortId}`)),
            `页面版本号与 latest.json 不符（应含 ${shortId}）——CDN 缓存或读错了源`,
        ).toBeVisible({ timeout: 30_000 });
    });
});
