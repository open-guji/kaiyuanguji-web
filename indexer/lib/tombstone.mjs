/**
 * tombstone.mjs — 升格墓碑字段的读取（detail 文件／build 产物 entry/<id>.json）。
 *
 * 墓碑字段有两种写法：build 产物里是 `promoted_to`（无下划线），旧的打包标志是 `_promoted_to`。
 * 只读其一会让另一种形态下的闸门看不见墓碑，所以两个键都认。
 */

/** 墓碑指向的新 id；不是墓碑返回 ''（doc 为 null／非对象也返回 ''） */
export function promotedTo(doc) {
    if (!doc || typeof doc !== 'object') return '';
    const v = doc.promoted_to || doc._promoted_to;
    return typeof v === 'string' ? v : '';
}

export const isPromotedTombstone = (doc) => promotedTo(doc) !== '';

/**
 * 并条墓碑：被并方只留 `merged_into`（指向留存方的记录 id），detail 文件里才有；
 * index/ 的 shard 条目不带它（derived.md〈八〉：检索端自行过滤），所以只能读 detail 判。
 * 网站对旧 id 的 308 读的也是这个字段（nextjs item-seo 的 mergedTarget）。
 * 值可以是字符串，或带 id 的对象（mergedTarget 两种都认）。
 */
export function mergedInto(doc) {
    if (!doc || typeof doc !== 'object') return '';
    const m = doc.merged_into;
    if (typeof m === 'string') return m;
    return m && typeof m === 'object' && typeof m.id === 'string' ? m.id : '';
}

export const isMergedTombstone = (doc) => mergedInto(doc) !== '';

/** 不该进检索的墓碑：升格墓碑（promoted_to）或并条墓碑（merged_into） */
export const isTombstone = (doc) => isPromotedTombstone(doc) || isMergedTombstone(doc);
