/**
 * 错误边界的「自动重试一次」（overview#322：读者第一次打开阅读页／条目页报错、刷新就好）。
 *
 * 只对「刷新多半就好」的错误自动重新加载：
 *   - 网络类：fetch 失败、连接断开、chunk 或 CSS 加载失败（RSC 导航时取数据或代码失败都是这类）；
 *   - 服务端渲染出的错（带 digest）：生产环境里服务端错误的原文被隐去，只剩 digest；
 *     这里多是取数时的临时故障（COS 网络错、5xx 抛错不缓存，见 lib/server/item-data.ts）。
 * 客户端代码自己的错（TypeError 等）刷新也不会好，不重试，直接出错误页。
 *
 * 防循环：同一地址 RETRY_WINDOW_MS 内只自动重试一次（sessionStorage），第二次失败就出错误页让读者自己选。
 * 与 ErrorMonitor 的 chunk 失效刷新各记各的键，互不影响。
 */
export const RETRY_WINDOW_MS = 60_000;
const KEY_PREFIX = 'kyg-auto-retry:';

const TRANSIENT = /failed to fetch|fetch failed|load failed|networkerror|network error|network request failed|loading (css )?chunk|failed to load chunk|dynamically imported module|connection (closed|reset)|econnreset|err_(empty_response|connection|network)|unexpected end of json/i;

export type RetryableError = Error & { digest?: string };

export function isTransientError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const e = err as RetryableError;
    if (e.name === 'ChunkLoadError') return true;
    if (typeof e.digest === 'string' && e.digest) return true;
    return TRANSIENT.test(`${e.name ?? ''} ${e.message ?? ''}`);
}

type Store = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * 这次该不该自动重试；该的话顺手记下时间。sessionStorage 不可用时不重试（没法防循环）。
 */
export function claimAutoRetry(path: string, store: Store | null | undefined, now = Date.now()): boolean {
    if (!store) return false;
    try {
        const key = KEY_PREFIX + path;
        const last = store.getItem(key);
        if (last !== null && now - Number(last) < RETRY_WINDOW_MS) return false;
        store.setItem(key, String(now));
        return true;
    } catch {
        return false;
    }
}

/** 浏览器里：是临时错误、且这个地址最近没自动重试过 → 记下并返回 true（调用方随即重新加载） */
export function shouldAutoRetry(err: unknown): boolean {
    if (typeof window === 'undefined' || !isTransientError(err)) return false;
    let store: Storage | null = null;
    try { store = window.sessionStorage; } catch { /* 隐私模式等 */ }
    return claimAutoRetry(window.location.pathname + window.location.search, store);
}

/** 整页重新加载（单列出来，单测里替换） */
export function reloadPage(): void {
    window.location.reload();
}
