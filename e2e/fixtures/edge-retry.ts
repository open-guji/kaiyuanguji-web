/**
 * 边缘瞬时 5xx 的重试（overview#484）。
 *
 * data 域名在部署窗口里会间歇回 525（边缘与源站 TLS 握手失败）、522／524（回源超时），与 503 同类：
 * 数据本身没问题，重试就过。前置条件探测（hasTextFile）原先对 5xx 直接抛，一次边缘抖动就让用例变红；
 * 这里把 503／522／524／525 当可重试，退避 2s／5s／10s，仍失败才返回最后一次响应让调用方照旧抛错。
 * 抛错信息带上 EO-LOG-UUID／Eo-Cache-Status／Date，便于在 EdgeOne 日志里按 UUID 查。
 */
export const EDGE_RETRY_STATUS = new Set([503, 522, 524, 525]);
export const EDGE_RETRY_DELAYS_MS = [2000, 5000, 10000];

interface ResponseLike {
    status(): number;
    headers(): Record<string, string>;
}

/** `EO-LOG-UUID=… Eo-Cache-Status=… Date=…`，没有的头不写；响应头名在 Playwright 里是小写 */
export function edgeHeaders(res: ResponseLike): string {
    const h = res.headers();
    return ['EO-LOG-UUID', 'Eo-Cache-Status', 'Date']
        .map((k) => [k, h[k.toLowerCase()]] as const)
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
}

/** 失败说明：`HTTP 525（525后重试 3 次仍失败）[EO-LOG-UUID=…]`；hdr 是各次尝试里最后一次带头的那份（见 getWithEdgeRetry） */
export function describeFailure(res: ResponseLike, retries: number, firstStatus: number, hdr = edgeHeaders(res)): string {
    return `HTTP ${res.status()}${retries ? `（${firstStatus}后重试 ${retries} 次仍失败）` : ''}${hdr ? ` [${hdr}]` : ''}`;
}

/**
 * 反复调用 fn，直到响应不是瞬时 5xx 或重试用尽；返回最后一次的响应与实际重试次数。
 * 只对 GET／HEAD 这类幂等请求用。
 */
export async function getWithEdgeRetry<T extends ResponseLike>(
    fn: () => Promise<T>,
    { delaysMs = EDGE_RETRY_DELAYS_MS, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) }: { delaysMs?: number[]; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ res: T; retries: number; firstStatus: number; hdr: string }> {
    let res = await fn();
    const firstStatus = res.status();
    let retries = 0;
    let hdr = edgeHeaders(res); // 重试途中拿到过的 EdgeOne 头留着，最后一次没带头也不丢
    while (EDGE_RETRY_STATUS.has(res.status()) && retries < delaysMs.length) {
        await sleep(delaysMs[retries++]);
        res = await fn();
        hdr = edgeHeaders(res) || hdr;
    }
    return { res, retries, firstStatus, hdr };
}
