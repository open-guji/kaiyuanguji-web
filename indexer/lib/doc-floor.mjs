/**
 * doc-floor.mjs — swap 前的文档数下限闸（纯函数）
 *
 * 事故（overview#122，10-02）：book-text 迁了新结构，搜索机上旧的 indexer 还在读旧目录，
 * 两晚夜间重建 juans 都建出 0 条。swap 前的自检对 juans 不查命中数（checkHits: false），
 * 空索引照样换了上去，整理本正文搜不到，持续约 29 小时。
 *
 * 规则：线上这个索引原来有文档、新建的 tmp 比它少一半以上，就当重建出了问题，放弃 swap、保留旧索引。
 * 线上还不存在或是空的（首次建、本来就空）不拦。各索引每晚的数据变动都远小于一半，正常发布碰不到这条线；
 * 真要大幅缩减（比如清掉一大批草稿），用 FORCE_SHRINK=1 或 --allow-shrink 放行。
 */

export const MIN_DOC_RATIO = 0.5;

/**
 * @param {number|null|undefined} liveDocs  线上索引现有文档数（不存在传 null）
 * @param {number|null|undefined} newDocs   新建 tmp 的文档数
 * @param {number} [minRatio]
 * @returns {{ ok: boolean, reason?: string }}
 */
export function checkDocFloor(liveDocs, newDocs, minRatio = MIN_DOC_RATIO) {
    if (!Number.isFinite(liveDocs) || liveDocs <= 0) return { ok: true };
    const n = Number.isFinite(newDocs) ? newDocs : 0;
    if (n >= liveDocs * minRatio) return { ok: true };
    return {
        ok: false,
        reason: `新索引只有 ${n} 条，线上现有 ${liveDocs} 条，少了 ${Math.round((1 - n / liveDocs) * 100)}%（下限：线上的 ${Math.round(minRatio * 100)}%）——`
            + `多半是数据源路径或结构变了、脚本读不到；确实要大幅缩减就带 --allow-shrink`,
    };
}
