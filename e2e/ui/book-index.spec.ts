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
        await expect(page.getByRole('link', { name: /古籍索引/ }).first()).toBeVisible();
    });
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

        // 「相关版本」区块——史記有 35 个版本，为空说明 books 关联没渲染
        await expect(
            page.getByText(/相关版本|相關版本/).first(),
            '缺「相关版本」区块',
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
