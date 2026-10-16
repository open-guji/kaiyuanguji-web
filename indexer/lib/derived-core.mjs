/**
 * derived-core.mjs — schema-v2 build 产物（`build/build_derived.py --out <dir>`）的取数核心（B5-3.3）。
 *
 * 打包侧（nextjs/scripts/lib/derived.mjs）与索引器共用同一份：分类取法、版本数、条目路径、
 * 「读产物／回退源档／缺失」计数与判闸。放在 indexer/lib/ 是因为搜索机只同步 indexer/ 目录；
 * 打包侧从这里 re-export，反过来不行（搜索机没有 nextjs/）。
 * 约束：不读环境变量、不持有模块级状态（计数器由调用方创建并传入）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const LEVELS = ['l1', 'l2', 'l3', 'l4'];

/**
 * 条目的分类，统一成 `{ l1, l2, l3, l4, source? }`，没有返回 null。
 * 取 `_classifications[]`（有多个分类法时优先 zongmu，否则第一个有 l1 的）；旧 `classification` 不读。
 * 黄金向量：nextjs/src/lib/server/__tests__/fixtures/classification-vectors.json（两侧测试共用）。
 */
export function classificationOf(d) {
    const list = Array.isArray(d?._classifications) ? d._classifications.filter((c) => c && typeof c === 'object') : [];
    const pick = list.find((c) => c.scheme === 'zongmu' && c.l1) ?? list.find((c) => c.l1);
    if (!pick) return null;
    const out = {};
    for (const k of LEVELS) out[k] = typeof pick[k] === 'string' ? pick[k] : '';
    if (pick.source) out.source = pick.source;
    return out;
}

/** 版本数（排序加权用）：build 产物的 `_edition_count`；没有给 0 */
export function editionCountOf(d) {
    return typeof d?._edition_count === 'number' ? d._edition_count : 0;
}

/** 产物里某条目的路径 */
export function entryPath(dir, id) {
    return join(dir, 'entry', `${id}.json`);
}

/** 读条目计数器：hit＝读到产物；draftSource＝草稿库无产物、读源档（预期）；missing＝生产库缺产物（要判失败） */
export function createReadStats() {
    return { hit: 0, draftSource: 0, missing: 0 };
}

/**
 * 条目详情。设了产物目录时：
 *  - 产物里有 → 读产物（hit）；
 *  - 没有且是草稿库（草稿库没有产物）→ 读源档（draftSource）；
 *  - 没有且是生产库 → 记 missing 并抛错（不回退源档：回退会让派生字段悄悄变空）。
 * 没设产物目录（旧 schema、ALLOW_NO_DERIVED）：照旧读源档，不计数。
 * 读不了／JSON 坏了抛错，由调用方按原样处理。
 */
export function readDetailDoc(detailPath, id, derivedDir = '', { isDraft = false, stats = null } = {}) {
    const dir = (derivedDir || '').trim();
    if (!dir) return JSON.parse(readFileSync(detailPath, 'utf-8'));
    const p = id ? entryPath(dir, id) : null;
    if (p && existsSync(p)) {
        const doc = JSON.parse(readFileSync(p, 'utf-8'));
        if (stats) stats.hit++;
        return doc;
    }
    if (isDraft) {
        const doc = JSON.parse(readFileSync(detailPath, 'utf-8'));
        if (stats) stats.draftSource++;
        return doc;
    }
    if (stats) stats.missing++;
    throw new Error(`生产库条目 ${id} 在 ${dir}/entry/ 里没有产物`);
}

/**
 * 汇总判闸：生产库缺产物条数 >0 就是问题（宁可不建，别建出派生字段为空的文档）。
 * @returns {string|null}
 */
export function readStatsProblem(stats) {
    if (!stats || !(stats.missing > 0)) return null;
    return `生产库有 ${stats.missing} 个条目读不到 derived 产物（hit ${stats.hit}，草稿读源档 ${stats.draftSource}）——产物不全，不建索引`;
}
