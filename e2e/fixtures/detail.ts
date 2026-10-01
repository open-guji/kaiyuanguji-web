import type { Locator, Page } from '@playwright/test';

/**
 * 条目页提要卡里的主按钮「閱讀」（book-index-ui 0.32.0 前叫「閱讀全文」，两种都认）。
 * 只在主区（<main>）的 .bim-d-btn 里找：顶栏导航也有一个「阅读」→ /read，按文案找会两个都命中。
 */
export function readButton(page: Page): Locator {
    return page.getByRole('main').locator('a.bim-d-btn').filter({ hasText: /^(阅读|閱讀)(全文)?$/ });
}
