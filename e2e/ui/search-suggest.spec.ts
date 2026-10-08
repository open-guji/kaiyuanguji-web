/**
 * 首页、元数据首页检索框的候选下拉（overview#342）。
 *
 * 候选走搜索 L1（同站 /api/search）。L1 是可降级依赖：它挂了只是不出候选，表单检索照常
 * （由 book-index.spec.ts 守）。所以每条先探一次代理，不通就跳过，不因 L1 故障拦发版；
 * 代理通而下拉不出，才是页面回归。（degradable 那一层在 CI 里不开浏览器，放不了这里的用例。）
 */
import { test, expect } from '../fixtures/test';
import { TARGET } from '../fixtures/anchors';

test.beforeEach(async ({ request }) => {
    const res = await request.get(`${TARGET}/api/search?q=${encodeURIComponent('武职')}&limit=8`, { timeout: 15_000 }).catch(() => null);
    const ok = !!res && res.ok() && ((await res.json().catch(() => null))?.results?.[0]?.hits?.length ?? 0) > 0;
    test.skip(!ok, '/api/search 不通或无结果（搜索 L1 可降级），候选无从验证');
});

const CASES = [
    { label: '首页', path: '/', name: '搜索古籍索引' },
    { label: '元数据首页', path: '/book-index', name: '检索古籍元数据' },
];

for (const { label, path, name } of CASES) {
    test.describe(`${label}检索候选`, () => {
        test('输入「武职」出候选（默认简体：书名出简体），点一条进条目页', async ({ page }) => {
            await page.goto(`${TARGET}${path}`);
            const box = page.getByRole('combobox', { name });
            await box.fill('武职');
            const options = page.getByRole('listbox').getByRole('option');
            await expect(options.first(), '/api/search 有结果，下拉却没出来').toBeVisible({ timeout: 15_000 });
            // 候选跟繁简偏好走（overview#342）：默认简体，代理按 locale=zh-Hans 转好
            await expect(options.filter({ hasText: '武职选簿' }).first()).toBeVisible();
            await expect(options.filter({ hasText: '武職選簿' })).toHaveCount(0);
            await expect(box).toHaveAttribute('aria-expanded', 'true');
            await options.first().click();
            await expect(page).toHaveURL(/\/item\/[0-9a-z]+/);
        });

        test('↓ 选中、Esc 收起，回车仍提交到结果页', async ({ page }) => {
            await page.goto(`${TARGET}${path}`);
            const box = page.getByRole('combobox', { name });
            await box.fill('武职');
            await expect(page.getByRole('option').first()).toBeVisible({ timeout: 15_000 });
            await box.press('ArrowDown');
            await expect(page.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
            await box.press('Escape');
            await expect(page.getByRole('listbox')).toHaveCount(0);
            await box.press('Enter');
            await expect(page).toHaveURL(/\/book-index\?q=/);
        });
    });
}
