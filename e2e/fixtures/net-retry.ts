/**
 * 网络抖动自动重试（overview#345 方案 A）。
 *
 * 背景：测试站前面的 EdgeOne 偶发 ERR_CONNECTION_RESET / ECONNRESET，
 * 让 verify / ui、contract 偶尔红一次，重跑就绿。这类错误是「请求根本没送达／没拿到响应」，
 * 与站点行为对错无关，重试几次是安全的；断言失败（内容不对、状态码不对）一律不重试。
 *
 * 重试范围：
 *   · 抛出的网络错误，消息命中 RETRYABLE_ERROR（连接重置／超时／被关）：page.goto / page.reload /
 *     APIRequestContext 的所有方法。
 *   · 仅 GET / HEAD：返回了 CDN 瞬时状态码（429 限速、522 回源超时、552）。
 *     返回 404、500 等「站点自己的回答」不重试。
 *   最多重试 3 次（共 4 次尝试），退避 1s、2s、4s（+ 抖动）；429 带 Retry-After 时按它等（上限 10s）。
 *   重试用尽仍失败，原样抛出最后一次的错误／返回最后一次的响应，由用例自己的断言判定。
 *
 * 用法：用例从 `../fixtures/test` 导入 test / expect，page、request、context、browser 就都带重试，
 * 不必逐用例改。环境变量 NET_RETRY=0 可整体关闭（排查时看原始失败）。
 */
import type { APIRequestContext, APIResponse, BrowserContext, Page } from '@playwright/test';

export const RETRYABLE_ERROR =
    /ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_CONNECTION_TIMED_OUT|ERR_EMPTY_RESPONSE|ECONNRESET|ETIMEDOUT|socket hang up/i;

/** CDN／回源的瞬时状态码（只对 GET／HEAD 重试） */
export const RETRYABLE_STATUS = new Set([429, 522, 552]);

export const MAX_RETRIES = 3;

export interface RetryOptions {
    maxRetries?: number;
    /** 第 n 次重试前等多久（毫秒），n 从 1 起；测试里可换成 0 */
    backoffMs?: (attempt: number, retryAfterMs?: number) => number;
    onRetry?: (info: { attempt: number; reason: string; what: string }) => void;
}

const defaultBackoff = (attempt: number, retryAfterMs?: number): number => {
    if (retryAfterMs !== undefined) return Math.min(retryAfterMs, 10_000);
    return 1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 300);
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const retryEnabled = () => process.env.NET_RETRY !== '0';

function retryAfter(res: APIResponse): number | undefined {
    const v = res.headers()['retry-after'];
    const s = v ? Number(v) : NaN;
    return Number.isFinite(s) && s >= 0 ? s * 1000 : undefined;
}

/** 通用：fn 抛网络错误就重试；statusOf 给出时，返回值的状态码命中瞬时状态码也重试 */
export async function withNetRetry<T>(
    what: string,
    fn: () => Promise<T>,
    opts: RetryOptions & { statusOf?: (r: T) => { status: number; retryAfterMs?: number } | undefined } = {},
): Promise<T> {
    if (!retryEnabled()) return fn();
    const max = opts.maxRetries ?? MAX_RETRIES;
    const backoff = opts.backoffMs ?? defaultBackoff;
    for (let attempt = 0; ; attempt++) {
        let result: T;
        let reason: string;
        let wait: number | undefined;
        try {
            result = await fn();
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (attempt >= max || !RETRYABLE_ERROR.test(msg)) throw e;
            reason = (msg.match(RETRYABLE_ERROR) as RegExpMatchArray)[0];
            opts.onRetry?.({ attempt: attempt + 1, reason, what });
            await sleep(backoff(attempt + 1));
            continue;
        }
        const st = opts.statusOf?.(result);
        if (!st || !RETRYABLE_STATUS.has(st.status) || attempt >= max) return result;
        reason = `HTTP ${st.status}`;
        wait = st.retryAfterMs;
        opts.onRetry?.({ attempt: attempt + 1, reason, what });
        await sleep(backoff(attempt + 1, wait));
    }
}

const REQUEST_METHODS = ['get', 'head', 'post', 'put', 'patch', 'delete', 'fetch'] as const;

/** 给 APIRequestContext 的实例方法套上重试（原地改，幂等） */
export function wrapRequest<T extends APIRequestContext>(ctx: T, opts: RetryOptions = {}): T {
    const marked = ctx as T & { __netRetry?: true };
    if (marked.__netRetry) return ctx;
    marked.__netRetry = true;
    for (const m of REQUEST_METHODS) {
        const orig = (ctx[m] as (...a: unknown[]) => Promise<APIResponse>).bind(ctx);
        (ctx as unknown as Record<string, unknown>)[m] = (url: unknown, options?: { method?: string }) => {
            const method = (m === 'fetch' ? options?.method ?? 'GET' : m).toUpperCase();
            const idempotentRead = method === 'GET' || method === 'HEAD';
            return withNetRetry(`${method} ${typeof url === 'string' ? url : '<request>'}`, () => orig(url, options), {
                ...opts,
                statusOf: idempotentRead ? (r) => ({ status: r.status(), retryAfterMs: retryAfter(r) }) : undefined,
            });
        };
    }
    return ctx;
}

/** 给 Page 的 goto / reload 套上重试，并把它的 request 也包上 */
export function wrapPage<T extends Page>(page: T, opts: RetryOptions = {}): T {
    const marked = page as T & { __netRetry?: true };
    if (marked.__netRetry) return page;
    marked.__netRetry = true;
    for (const m of ['goto', 'reload'] as const) {
        const orig = (page[m] as (...a: unknown[]) => Promise<unknown>).bind(page);
        (page as unknown as Record<string, unknown>)[m] = (...args: unknown[]) =>
            withNetRetry(`page.${m}${typeof args[0] === 'string' && m === 'goto' ? ' ' + args[0] : ''}`, () => orig(...args), opts);
    }
    wrapRequest(page.request, opts);
    return page;
}

/** 给 BrowserContext 套上：newPage 出来的页、context.request 都带重试 */
export function wrapContext<T extends BrowserContext>(ctx: T, opts: RetryOptions = {}): T {
    const marked = ctx as T & { __netRetry?: true };
    if (marked.__netRetry) return ctx;
    marked.__netRetry = true;
    const newPage = ctx.newPage.bind(ctx);
    ctx.newPage = async () => wrapPage(await newPage(), opts);
    wrapRequest(ctx.request, opts);
    return ctx;
}
