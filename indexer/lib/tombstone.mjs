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
