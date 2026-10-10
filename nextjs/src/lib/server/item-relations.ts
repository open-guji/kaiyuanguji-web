/**
 * 条目关系与分类的统一读取口（schema-v2 双兼容，overview#458）。
 *
 * 只读 build 产物 `entry/<id>.json` 里的 `_` 派生字段。旧字段回退（`books`／`contained_works`／`contained_in`／`works`／`classification`）
 * 已删（overview#522：`STRICT_DERIVED=1` 进 CI 后回退命中为 0；overview#432 起打包只读正式仓）。
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

/** 本条的版本（Work）：`_books` */
export function booksOf(e: ItemEntry): unknown[] {
    return arr((e as Json)._books);
}

/** 丛编成员：`_members`（只含前 20 项，总数看 `_member_count`） */
export function membersOf(e: ItemEntry): unknown[] {
    return arr((e as Json)._members);
}

/** 所属丛编：`_collections` */
export function collectionsOf(e: ItemEntry): unknown[] {
    return arr((e as Json)._collections);
}

/** 人物著录作品：`_works` */
export function worksOf(e: ItemEntry): unknown[] {
    return arr((e as Json)._works);
}

/** 分类：`_classifications[]`（优先 zongmu，否则第一个有 l1 的）；没有给空对象 */
export function classificationOf(e: ItemEntry): Json {
    const list = arr((e as Json)._classifications).map(obj);
    return list.find((c) => c.scheme === 'zongmu' && str(c.l1)) ?? list.find((c) => str(c.l1)) ?? {};
}
