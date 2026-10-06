/**
 * v-search-prune.mjs — 清理桶里旧的 v/<版本键>/ 搜索分片目录（纯函数，无副作用）
 *
 * 背景（overview#410）：每次发布都会在 v/ 下新建两份搜索分片：v/<cacheKey>/search/（新前端用）和
 * v/<commitId>/search/（服务端 copy，给旧前端用）。以前从不清理，桶里对象数涨到 139 万，
 * 远多于在用的约 33 万。分片只跟「当时那版数据」配套，旧版本的没有人再读（回滚是重新发布，会重新生成）。
 *
 * 规则：本次发布的 cacheKey／commitId 两个目录一定保留；其余按最后写入时间从新到旧只留 keep 个，更旧的删。
 * 取不到时间的目录（刚好在列的时候被别的发布写到一半）不动。
 */

export const DEFAULT_KEEP_VERSIONS = 10; // 目录数；每次发布占 2 个，约等于最近 5 次发布

/**
 * @param {Array<{name: string, lastModified: number|null}>} dirs  v/ 下的各版本目录（name 不带斜杠）
 * @param {object} p
 * @param {Iterable<string>} p.protect  一定保留的目录名（本次发布的 cacheKey、commitId）
 * @param {number} [p.keep]  除 protect 外，保留最新的几个
 * @returns {{toDelete: string[], toKeep: string[]}}
 */
export function planVersionPrune(dirs, { protect = [], keep = DEFAULT_KEEP_VERSIONS } = {}) {
    const protectedNames = new Set(protect);
    const rest = [];
    const toKeep = [];
    for (const d of dirs) {
        if (protectedNames.has(d.name) || d.lastModified == null || Number.isNaN(d.lastModified)) toKeep.push(d.name);
        else rest.push(d);
    }
    rest.sort((a, b) => b.lastModified - a.lastModified || (a.name < b.name ? -1 : 1));
    const n = Math.max(0, keep);
    for (const d of rest.slice(0, n)) toKeep.push(d.name);
    return { toDelete: rest.slice(n).map(d => d.name).sort(), toKeep: toKeep.sort() };
}
