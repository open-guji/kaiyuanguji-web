/**
 * 投机预取（overview#345 PR②）：阅读页首次渲染的取数是串行的——manifest → 版本 index → 首章，每跳在冷门页上约 0.4s。
 * 版本 key 和章号在多数地址里是已知或几乎必然的（没写 key ＝ 主版本多半是 default；没写章 ＝ 多半是 001），
 * 所以在拿到 manifest 之前就把 index 和首章先发出去，与 manifest 并行。
 *
 * **只是把同一个请求提前发出，结果完全不变**：之后调用方（checkReader／preloadReader）照常按 manifest 校验后的
 * 版本与章号去取，地址与预取的某一条相同就直接用那个已在路上的请求；不同（猜错）就忽略预取、按原路径新发一次。
 * - 预取失败（网络错、404 抛的 NotFound 等）一律吞掉，不冒泡、不产生未处理的 rejection；
 *   之后真有人要这个地址时，预取的结果若是失败就**重新取一次**，与没预取时一模一样。
 * - 一次预取只能被消费一次（取走即删），不做跨请求缓存——缓存由底层取数实例（LRU）管。
 * - 只发往传进来的取数函数（我们自己的 COS／data 源），不碰第三方。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyGet = (relPath: string, ...rest: any[]) => Promise<any>;

export interface SpeculativeGetter<F extends AnyGet> {
    /** 与原函数同签名：有同参数的预取在路上就用它，否则（或预取失败）原样调用 */
    get: F;
    /** 提前发出一个请求（参数与 get 一致，含 maxBytes 之类附加参数） */
    prefetch: (...args: Parameters<F>) => void;
    /** 还没被消费的预取个数（测试用） */
    pending: () => number;
}

export function withSpeculation<F extends AnyGet>(baseFn: F): SpeculativeGetter<F> {
    // 内部按「任意参数」调用：F 的泛型参数在这里展开不了，对外仍保留 F 的完整签名
    const base = baseFn as unknown as (relPath: string, ...rest: unknown[]) => Promise<unknown>;
    const memo = new Map<string, Promise<unknown>>();
    const keyOf = (args: unknown[]) => JSON.stringify(args);
    const get = ((...args: unknown[]) => {
        const k = keyOf(args);
        const p = memo.get(k);
        if (!p) return base(...(args as [string, ...unknown[]]));
        memo.delete(k);
        // 预取失败＝当没预取过：重新取一次，抛错也与直接调用一致
        return p.catch(() => base(...(args as [string, ...unknown[]])));
    }) as F;
    const prefetch = (...args: Parameters<F>) => {
        const k = keyOf(args);
        if (memo.has(k)) return;
        let p: Promise<unknown>;
        try {
            p = Promise.resolve(base(...(args as [string, ...unknown[]])));
        } catch {
            return;
        }
        p.catch(() => { /* 没人要它时的失败不算事 */ });
        memo.set(k, p);
    };
    return { get, prefetch, pending: () => memo.size };
}
