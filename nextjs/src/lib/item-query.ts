/**
 * 条目页 /item/<id> 的查询参数白名单（overview#280 S1）。
 *
 * 条目页的内容只由路径决定，任何多余参数（utm_*、fbclid、spm、爬虫或分享链接自带的）都会让 CDN
 * 把它当成另一个 URL：每次 Cache Miss、都进云函数，占函数调用额度。控制台规则对 Pages 自定义域名
 * 不生效（overview#170），所以在中间件里 308 到干净地址。
 *
 * 白名单是条目页详情组件自己的 URL 状态（BookDetailContent 读写的那几个），带着它们的外部链接
 * 要保留视图，不能删：
 *   tab／juan／page／mode／collection  ——详情组件的页签、卷、分页、谱系视图
 *   redirected_from／no_redirect       ——草稿升格横幅的往返
 * 纯函数，不依赖 React／Next：中间件（边缘运行时）与测试共用。
 */
export const ITEM_QUERY_WHITELIST: readonly string[] = ['tab', 'juan', 'page', 'mode', 'collection', 'redirected_from', 'no_redirect'];

/**
 * 白名单之外的参数全部去掉，白名单内的保持原顺序、原值（含重复键）。
 * 没有要去掉的返回 null（不必跳）；否则返回清理后的查询串（带前导 ?，全清光则为空串）。
 */
export function cleanItemSearch(params: URLSearchParams): string | null {
    const keep = new URLSearchParams();
    let dropped = false;
    params.forEach((value, key) => {
        if (ITEM_QUERY_WHITELIST.includes(key)) keep.append(key, value);
        else dropped = true;
    });
    if (!dropped) return null;
    const s = keep.toString();
    return s ? `?${s}` : '';
}

/**
 * 条目页退到 /book-index 由客户端查升格表时的地址：`id` 加上白名单里的参数（tab／page／mode 等详情状态原样带过去，
 * 外部链接带的视图不丢），白名单之外的参数去掉。
 */
export function bookIndexFallbackPath(id: string, params: URLSearchParams): string {
    const q = new URLSearchParams({ id });
    params.forEach((value, key) => {
        if (ITEM_QUERY_WHITELIST.includes(key)) q.append(key, value);
    });
    return `/book-index?${q.toString()}`;
}
