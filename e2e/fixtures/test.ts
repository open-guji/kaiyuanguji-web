/**
 * 带「网络抖动自动重试」的 test / expect（overview#345 方案 A，规则见 net-retry.ts）。
 *
 * 用例一律从这里导入，不要直接从 '@playwright/test' 导入 test：
 *     import { test, expect } from '../fixtures/test';
 * page / context / browser.newContext() 出来的页 / request 的 goto、reload、get 等就自带重试，
 * 连接重置类错误不再让整条用例红。重试发生时在报告里记一条 net-retry 注解、控制台打一行，便于事后统计。
 */
import { test as base, expect } from '@playwright/test';
import { wrapContext, wrapPage, wrapRequest, type RetryOptions } from './net-retry';

const onRetry: RetryOptions['onRetry'] = ({ attempt, reason, what }) => {
    const desc = `${what}：${reason}，第 ${attempt} 次重试`;
    console.warn(`[net-retry] ${desc}`);
    try {
        base.info().annotations.push({ type: 'net-retry', description: desc });
    } catch {
        /* worker 级 fixture 里没有当前用例 */
    }
};
const opts: RetryOptions = { onRetry };

export const test = base.extend({
    request: async ({ request }, use) => {
        await use(wrapRequest(request, opts));
    },
    context: async ({ context }, use) => {
        await use(wrapContext(context, opts));
    },
    page: async ({ page }, use) => {
        await use(wrapPage(page, opts));
    },
    // 用例里自己 browser.newContext()／newPage() 的，也要带上
    browser: [
        async ({ browser }, use) => {
            const newContext = browser.newContext.bind(browser);
            const newPage = browser.newPage.bind(browser);
            browser.newContext = async (o) => wrapContext(await newContext(o), opts);
            browser.newPage = async (o) => wrapPage(await newPage(o), opts);
            await use(browser);
        },
        { scope: 'worker' },
    ],
});

export { expect };
export type { Page, Locator, APIRequestContext, APIResponse, BrowserContext } from '@playwright/test';
