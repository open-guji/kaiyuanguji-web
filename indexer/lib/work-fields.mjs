/**
 * works 索引新增的两个可过滤字段（overview#291 P1a，搜索页 v4 的「部类」「存佚」筛选）。
 * 抽成纯函数，是为了不用起 Meili 就能单测（full-reindex.mjs 一 import 就会跑 main）。
 */

/** 存佚只认数据里的三个值（同 nextjs/src/lib/server/item-summary.ts 的 lossStatusText），别的（含缺）一律空串 */
export const LOSS_STATUS_VALUES = ['extant', 'partially_extant', 'lost'];

/**
 * 部（一级分类）：Work 详情里 `classification` 是 { l1, l2, l3, l4, basis, source }，
 * 取 l1（如「經部」「史部」）。多个来源按顺序取第一个非空的（详情优先，分片行兜底）；都没有返回空串，
 * 前端把空串当「未分類」。保持数据原文（繁体），不在这里转简体——筛选值与总目树的节点名一致。
 */
export function classificationL1(...sources) {
    for (const s of sources) {
        const l1 = s && typeof s === 'object' ? s.l1 : undefined;
        if (typeof l1 === 'string' && l1.trim()) return l1.trim();
    }
    return '';
}

export function lossStatusValue(...values) {
    for (const v of values) {
        if (typeof v === 'string' && LOSS_STATUS_VALUES.includes(v)) return v;
    }
    return '';
}

/**
 * 「有文本」（用户 10-01：页面上「全文」「整理本」统一叫「文本」，搜索筛选合成一个「有文本」，overview#322）。
 * 代理的 filter 只放行 AND，写不出 has_text OR has_collated，所以在索引侧合一：
 * has_text 写成「有转录全文或有整理本」。has_collated 字段照旧保留（排序加权、旧链接用）。
 */
export function hasTextValue(entry) {
    return !!(entry && (entry.has_text || entry.has_collated));
}
