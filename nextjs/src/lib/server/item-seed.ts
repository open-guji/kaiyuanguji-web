/**
 * 条目页（/item/[id]）内嵌 `initialDetail` 的体积上限（overview#458 批次 0.1 的后续）。
 *
 * 内嵌＝条目 JSON 进 HTML 的 RSC 载荷，省掉客户端一次条目请求；但 EdgeOne 对 `/item/*` 的
 * SSR 响应不压缩（2026-10-08 实测无 Content-Encoding），而独立请求走数据域是 br 压缩的。
 * 实测（线上，未压缩字节）：史記页 83 KB（载荷 52 KB，独立请求 13.6 KB br）、宋史百衲本页 91 KB
 * （载荷 70 KB，独立请求 4 KB br）。条目越大，内嵌越亏：内嵌成本≈原始字节，独立请求≈br 字节＋1 次往返，
 * 移动网络（~1.5 Mbps）50 KB≈0.27 s，已接近省下一次往返的收益。故超过阈值就不内嵌，客户端照旧取数。
 *
 * 阈值按条目 JSON 的 UTF-8 字节数算（汉字 3 字节，字符数会低估传输成本）。
 * 目前只有库里最大的几个 Book（如百衲本宋史 66 KB）超限；史記 31 KB、冊府元龜 47 KB 仍内嵌。
 * TODO(重估)：schema-v2 批次 2 之后聚合字段（_works／_members 等）进条目，体积会涨；
 * EdgeOne 对 /item/* 开了压缩之后，上限可放宽或取消。
 */
export const INITIAL_DETAIL_MAX_BYTES = 48_000;

/** 条目够小就返回它（作 initialDetail），否则返回 undefined（不内嵌，客户端取数）。 */
export function seedForItem<T extends object>(entry: T): T | undefined {
    return Buffer.byteLength(JSON.stringify(entry), 'utf8') <= INITIAL_DETAIL_MAX_BYTES ? entry : undefined;
}
