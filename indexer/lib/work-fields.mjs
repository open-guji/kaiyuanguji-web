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

/**
 * schema-v2（overview#458）：build 产物里的 `_classifications[]`（优先 zongmu，否则第一个有 l1 的），
 * 取成与旧 `classification` 同形的 { l1 }；没有返回 null。给 classificationL1 做第一来源（第二来源只剩分片行）。
 */
export function derivedClassification(detail) {
    const list = Array.isArray(detail?._classifications) ? detail._classifications.filter((c) => c && typeof c === 'object') : [];
    return list.find((c) => c.scheme === 'zongmu' && c.l1) ?? list.find((c) => c.l1) ?? null;
}

/** 版本数（排序加权用）：build 产物的 `_edition_count`；没有给 0 */
export function editionCount(detail) {
    return typeof detail?._edition_count === 'number' ? detail._edition_count : 0;
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

/**
 * swap 前的部类覆盖闸（overview#345，10-11 事故）：搜索机读原始仓，原始 Work 里没有 `classification`，
 * 部类只来自 build 产物的 `_classifications`；indexer 一旦读不到它，works 全部 classification 都是空串，
 * 但「带 classification 的过滤能跑通」那道检查（0 条也算过）发现不了——搜索页所有部类筛选恒为 0 条。
 * 四部是总目的一级分类，任何正常数据里每一部都该有大量 works；带 is_draft=false 查到 0 条就是没读到。
 * @param {Record<string, number|undefined>} hitsByBu  四部各自的 estimatedTotalHits
 * @returns {string|null} 有问题返回原因；没问题 null
 */
export const FOUR_BU = ['經部', '史部', '子部', '集部'];
export function classificationCoverageProblem(hitsByBu) {
    const empty = FOUR_BU.filter((bu) => !(Number(hitsByBu?.[bu]) > 0));
    if (empty.length === 0) return null;
    return `新建的 works 里 ${empty.join('、')} 查到 0 条——部类字段没读到（多半 indexer 读不到 build 产物的 _classifications，搜索页所有部类筛选会恒为 0 条）`;
}

/**
 * 部类非空比例闸（Eden 补充）：与线上现索引的同字段非空比例比，掉超过 5 个百分点就拒绝；
 * 同时始终套绝对下限（线上基线坏了也不会放过）。比例＝带四部之一的 works / 非草稿 works 总数。
 * @param {number|null} liveRatio  线上比例；无基线传 null
 * @param {number} newRatio        新建 tmp 的比例
 * @returns {string|null}
 */
export const BU_RATIO_MAX_DROP = 0.05;
// 绝对下限 60%：Eden 实测真实产物里带四部的占非草稿 Work 的 69.3%（overview#557，Mason 定）
export const BU_RATIO_ABS_MIN = 0.6;
export function classificationRatioProblem(liveRatio, newRatio) {
    const pct = (x) => `${(x * 100).toFixed(1)}%`;
    if (!Number.isFinite(newRatio)) return '新建 works 的部类非空比例算不出来';
    // 线上基线本身坏了（低于绝对下限，如今晚事故的 ≈0%）时「掉幅<5pp」恒真，所以下限始终生效：门槛 = max(线上-5pp, 绝对下限)
    const floor = Math.max(Number.isFinite(liveRatio) ? liveRatio - BU_RATIO_MAX_DROP : 0, BU_RATIO_ABS_MIN);
    if (newRatio >= floor) return null;
    return Number.isFinite(liveRatio)
        ? `部类非空比例 ${pct(newRatio)}，低于门槛 ${pct(floor)}（线上 ${pct(liveRatio)} 掉 ${BU_RATIO_MAX_DROP * 100}pp 与绝对下限 ${pct(BU_RATIO_ABS_MIN)} 取大）`
        : `无线上基线，部类非空比例 ${pct(newRatio)} 低于下限 ${pct(BU_RATIO_ABS_MIN)}`;
}

/**
 * 产物（BOOK_INDEX_DERIVED_DIR）准入：源仓是 schema-v2（有 build/build_derived.py）时，没有产物目录、
 * 或产物里记的 book-index sha（<dir>/SOURCE_COMMIT）与源仓 HEAD 不一致，都不许建——宁可不建，也别建出空部类。
 * @returns {string|null} 问题；null＝可以建
 */
export function derivedInputProblem({ schemaV2, derivedDir, dirExists, derivedCommit, sourceCommit }) {
    if (!schemaV2) return null;
    if (!derivedDir) return '源仓是 schema-v2，但没设 BOOK_INDEX_DERIVED_DIR——读不到 _classifications，部类会全空';
    if (!dirExists) return `BOOK_INDEX_DERIVED_DIR=${derivedDir} 不存在`;
    if (!derivedCommit) return `${derivedDir}/SOURCE_COMMIT 缺失，无法确认产物与源仓同一 commit`;
    if (!sourceCommit) return '读不到源仓 HEAD，无法核对产物 commit';
    if (derivedCommit !== sourceCommit) return `产物对应 commit ${derivedCommit.slice(0, 12)}，源仓 HEAD 是 ${sourceCommit.slice(0, 12)}，不一致`;
    return null;
}

/**
 * 版本数覆盖闸（Eden/Mason，overview#557）：editionCount 只进复合字段 completeness，Meili 里查不到，
 * 所以建文档时就地统计「非草稿 works 里 _edition_count 是数字的」与「>0 的」。
 * 两条硬线：① 有数字的比例 <95%（派生产物每个 Work 都带，读不到产物时全缺）；
 * ② >0 的比例 <30%（Eden 实测真实产物 41.0%，Mason 定下限 30%）。
 * @param {{ total: number, present: number, positive: number }} c
 * @returns {string|null}
 */
export const EDITION_PRESENT_MIN = 0.95;
export const EDITION_POSITIVE_MIN = 0.3;
export function editionCoverageProblem(c) {
    if (!c || !(c.total > 0)) return null;
    const pct = (x) => `${(x * 100).toFixed(1)}%`;
    const present = c.present / c.total;
    if (present < EDITION_PRESENT_MIN) {
        return `非草稿 works ${c.total} 条里只有 ${c.present} 条带 _edition_count（${pct(present)}，下限 ${pct(EDITION_PRESENT_MIN)}）——产物没读到，completeness 排序加权会塌成 0`;
    }
    const positive = c.positive / c.total;
    if (positive < EDITION_POSITIVE_MIN) {
        return `非草稿 works ${c.total} 条里 _edition_count>0 的只有 ${c.positive} 条（${pct(positive)}，下限 ${pct(EDITION_POSITIVE_MIN)}）——版本数多半没读对`;
    }
    return null;
}
