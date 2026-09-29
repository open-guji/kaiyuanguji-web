/**
 * sitemap-nodes.mjs — 总目与阅读首页分类节点页的 sitemap 条目（overview#280 S3，#242）。
 *
 * 节点树来自构建期索引：catalog/tree.json（古籍总目）、read/tree.json（阅读首页，同一套节点 id，
 * 只计可读作品）。每个节点（含子孙层级）一个地址的第 1 页；翻页（&page=N）不列，靠页面里的分页链接被爬到
 * （节点页第 1 页的 canonical 不带 page，翻页页各自 canonical，见 catalog/read 两个 page.ssr.tsx）。
 * 总目不列「全部」；read/tree.json 缺（这一版数据还没有阅读索引）就只列总目的。
 */

/** 树里所有节点 id（含各级子孙），按树的先后次序 */
export function nodeIds(tree) {
    const out = [];
    const walk = (nodes) => {
        for (const n of nodes ?? []) {
            if (n && typeof n.id === 'string' && /^[0-9a-z]{1,24}$/.test(n.id)) out.push(n.id);
            if (n?.children) walk(n.children);
        }
    };
    walk(tree);
    return out;
}

/**
 * @param {{ catalog?: any[] | null, read?: any[] | null }} trees
 * @returns {string[]} 站内路径（含查询串，未转义 &）
 */
export function nodePagePaths({ catalog, read }) {
    return [
        ...(catalog ? nodeIds(catalog).map((id) => `/catalog?node=${id}`) : []),
        ...(read ? nodeIds(read).map((id) => `/read?node=${id}`) : []),
    ];
}
