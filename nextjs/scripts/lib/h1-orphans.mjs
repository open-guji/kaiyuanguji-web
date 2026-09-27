/**
 * h1-orphans.mjs — h1 布局 entry 孤儿的「保留 7 天再删」状态机（纯函数，无副作用）
 *
 * 背景（协调者验收第三轮，2026-09-26 20:30Z）：第二轮把 entry 孤儿的年龄算成
 * 「上传时间」是错的——一个 30 天前上传、今天才被新版替换的 entry，年龄会被
 * 算成 30 天，当场就删了，而它恰恰是最需要保留 7 天的那种（刚失效，读者手里
 * 可能还有指向它的旧缓存分片）。
 *
 * 正确的量是「成为孤儿的时间」，不是「上传的时间」。这张表本身必须放在 COS
 * 上（`h1/_meta/orphans.json`）——CI 每次都是全新 checkout，本地状态活不过
 * 一次运行，算「孤儿多老」这件事没有本地状态可谈。
 *
 * 状态转移（每次 sync 调用一次 planOrphans）：
 *   1. 本轮新出现的孤儿（之前 state 里有、这次本地没有的 entry 相对路径）
 *      且表里还没有 → 记为「现在」（added）。
 *   2. 表里有、但这次本地又出现了（hash 变回了旧值）→ 移出表（reReferenced），
 *      不算删除也不算保留，因为它已经不是孤儿了。
 *   3. 剩下表里的每一条，按 `now - orphanedSince` 是否 ≥ 7 天分进
 *      toDelete／toKeep；toDelete 的同时从返回的新表里移除
 *      （删除动作由调用方去做，这里只算「该不该删」）。
 */

export const ORPHAN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * @param {object} p
 * @param {Map<string, number>} p.orphansTable  现有孤儿表：rel → orphanedSince(ms)
 * @param {Iterable<string>} p.candidateOrphanRels  本轮新判定为孤儿候选的相对路径
 *        （即：上一次已知 state 里有、这一次本地文件里没有的 entry 相对路径）
 * @param {Set<string>} p.currentLocalEntryRelSet  本轮本地实际存在的 entry 相对路径集合
 * @param {number} [p.now]  当前时间（ms），测试用，默认 Date.now()
 * @returns {{ newOrphansTable: Map<string, number>, toDelete: string[], toKeep: string[], added: number, reReferenced: number }}
 */
export function planOrphans({ orphansTable, candidateOrphanRels, currentLocalEntryRelSet, now = Date.now() }) {
    const table = new Map(orphansTable);
    let added = 0;
    let reReferenced = 0;

    for (const rel of candidateOrphanRels) {
        if (!table.has(rel)) {
            table.set(rel, now);
            added++;
        }
    }

    for (const rel of [...table.keys()]) {
        if (currentLocalEntryRelSet.has(rel)) {
            table.delete(rel);
            reReferenced++;
        }
    }

    const toDelete = [];
    const toKeep = [];
    for (const [rel, since] of table.entries()) {
        if (now - since >= ORPHAN_RETENTION_MS) toDelete.push(rel);
        else toKeep.push(rel);
    }
    for (const rel of toDelete) table.delete(rel);

    return { newOrphansTable: table, toDelete, toKeep, added, reReferenced };
}

/** orphans.json 的序列化/反序列化：{ version: 1, updatedAt, orphans: { rel: since } } */
export function serializeOrphansTable(table) {
    return JSON.stringify({
        version: 1,
        updatedAt: new Date().toISOString(),
        orphans: Object.fromEntries(table),
    });
}

export function parseOrphansTable(raw) {
    try {
        const doc = JSON.parse(raw);
        if (doc?.version !== 1 || !doc?.orphans) return new Map();
        return new Map(Object.entries(doc.orphans));
    } catch {
        return new Map();
    }
}
