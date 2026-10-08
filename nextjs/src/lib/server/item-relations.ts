/**
 * 条目关系与分类的统一读取口（schema-v2 双兼容，overview#458）。
 *
 * 新字段（build 产物 `entry/<id>.json` 里的 `_` 派生字段）有内容就用新的，没有就回退旧字段；
 * 旧 schema 的条目没有 `_` 字段，走旧路径，行为不变。切换稳定后删回退分支即 F4-5 批次 3.7，只改本文件。
 */
import type { ItemEntry } from './item-data';

type Json = Record<string, unknown>;

function arr(v: unknown): unknown[] {
    return Array.isArray(v) ? v : [];
}

function str(v: unknown): string {
    return typeof v === 'string' ? v.trim() : '';
}

function obj(v: unknown): Json {
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {};
}

function preferred(e: ItemEntry, newKey: string, oldKey: string): unknown[] {
    const n = arr((e as Json)[newKey]);
    return n.length ? n : arr((e as Json)[oldKey]);
}

/** 本条的版本（Work）：`_books` 优先，回退 `books` */
export function booksOf(e: ItemEntry): unknown[] {
    return preferred(e, '_books', 'books');
}

/** 丛编成员：`_members`（只含前 20 项，总数看 `_member_count`）优先，回退 `contained_works`＋`books` */
export function membersOf(e: ItemEntry): unknown[] {
    const m = arr((e as Json)._members);
    return m.length ? m : [...arr(e.contained_works), ...arr(e.books)];
}

/** 所属丛编：`_collections` 优先，回退 `contained_in` */
export function collectionsOf(e: ItemEntry): unknown[] {
    return preferred(e, '_collections', 'contained_in');
}

/** 人物著录作品：`_works` 优先，回退 `works` */
export function worksOf(e: ItemEntry): unknown[] {
    return preferred(e, '_works', 'works');
}

/** 分类：`_classifications[]`（优先 zongmu，否则第一个有 l1 的）优先，回退旧 `classification` */
export function classificationOf(e: ItemEntry): Json {
    const list = arr((e as Json)._classifications).map(obj);
    const pick = list.find((c) => c.scheme === 'zongmu' && str(c.l1)) ?? list.find((c) => str(c.l1));
    return pick ?? obj(e.classification);
}
