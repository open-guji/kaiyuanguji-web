/**
 * h1-roots.mjs — h1 版本根清单（S3）的纯函数：算「在用 root 集合」、算 manifest
 * 分片／roots 文件谁该删（无副作用，跟 h1-orphans.mjs 同一个写法）。
 *
 * 背景（任务书 S3-h1版本根清单）：A3/A3b 的 manifest 分片是固定路径、原地
 * 覆盖，同一时刻只能有一个版本——测试站与正式站没法各看各的数据版本，
 * 一次发布的 1,296 个分片也不是原子切换。改法：
 *   1. manifest 分片按内容哈希命名（h1-hash-common.mjs 的 writeHashedShards）；
 *   2. 每次发布生成一个不可变的 roots/<key>.json，列出本版所有分片的
 *      文件名（本文件的 key → hash8 表）；
 *   3. manifest-root.json 降级成一个「当前指针指向哪个 root」的短缓存指针；
 *   4. 孤儿判定从「本地没有就删」改成「不被任何在用 root 引用才删」——
 *      在用 root = 当前指针、测试站指针（若配置了）、外加最近 N 个（默认 5，
 *      防止读者手里缓存的旧指针/旧分片还没过期就把它依赖的东西删了）。
 *
 * entry/text 本身的孤儿（7 天保留期）不受影响，仍走 h1-orphans.mjs 那一套——
 * 两件事的"孤儿"定义完全不同，处理对象也不同（entry/text 文件 vs manifest
 * 分片／roots 文件），故意分成两个模块。
 *
 * 三个纯函数各管一段：
 *   planLiveCommits      — 给定 ledger（历史发布过的 commit 列表）与本轮新
 *                          commit、当前/测试站指针，算出"在用"的 commit 集合，
 *                          顺手把 ledger 收敛到只剩在用的（下次发布继续用）。
 *   planShardRetention   — 给定所有在用 commit 各自的 root 文档（shards 映射）
 *                          与 COS 上实际存在的分片文件名，算哪些分片文件已经
 *                          不被任何在用 root 引用，可以删。
 *   planRootsFileRetention — 给定在用 commit 集合与 COS 上实际存在的 roots/
 *                          文件名，算哪些 roots 文件本身也可以删（早已退出
 *                          在用集合的旧发布）。
 */

/**
 * @param {object} p
 * @param {Array<{commit: string, generatedAt: number}>} p.ledger  历史发布记录
 *        （未必已含本轮 newCommit）
 * @param {string} p.newCommit  本轮要发布的新 commit key（一定视为在用）
 * @param {string|null} [p.currentPointerCommit]  当前指针（发布前，仍是旧值）
 *        指向的 commit；没有旧指针（首次发布）传 null
 * @param {string|null} [p.stagingPointerCommit]  测试站指针指向的 commit；
 *        没配置测试站指针（今天的常态）传 null
 * @param {number} [p.keepN]  额外保留最近几个（默认 5，可配）
 * @param {number} [p.now]  当前时间（ms），测试用，默认 Date.now()
 * @returns {{
 *   liveCommitSet: Set<string>,
 *   prunedLedger: Array<{commit: string, generatedAt: number}>,
 *   retiredCommits: string[],
 * }}
 */
export function planLiveCommits({
    ledger,
    newCommit,
    currentPointerCommit = null,
    stagingPointerCommit = null,
    keepN = 5,
    now = Date.now(),
}) {
    const byCommit = new Map(ledger.map(e => [e.commit, e.generatedAt]));
    if (!byCommit.has(newCommit)) byCommit.set(newCommit, now);

    const merged = [...byCommit.entries()].map(([commit, generatedAt]) => ({ commit, generatedAt }));
    merged.sort((a, b) => b.generatedAt - a.generatedAt); // 新到旧

    const topN = merged.slice(0, keepN).map(e => e.commit);
    const liveCommitSet = new Set([...topN, currentPointerCommit, stagingPointerCommit, newCommit].filter(Boolean));

    const prunedLedger = merged.filter(e => liveCommitSet.has(e.commit));
    const retiredCommits = merged.filter(e => !liveCommitSet.has(e.commit)).map(e => e.commit);

    return { liveCommitSet, prunedLedger, retiredCommits };
}

/**
 * @param {object} p
 * @param {Array<Record<string, string>>} p.liveShardsMaps  每个在用 commit 的
 *        root 文档里的 shards 映射（suffix → hash8），拉不到的（如异常缺失）
 *        调用方传空对象即可，不影响其余 commit 的贡献
 * @param {Iterable<string>} p.cosShardFiles  COS 上 manifest 前缀下实际存在的
 *        相对文件名（如 "aa.1a2b3c4d.json"，含布局迁移前遗留的无哈希旧名
 *        "aa.json" 也一样处理——反正不会出现在 liveShardFiles 里，自然判定删除）
 * @returns {{ toDelete: string[], liveFileCount: number }}
 */
export function planShardRetention({ liveShardsMaps, cosShardFiles }) {
    const liveFiles = new Set();
    for (const shards of liveShardsMaps) {
        for (const [suffix, hash] of Object.entries(shards || {})) {
            liveFiles.add(`${suffix}.${hash}.json`);
        }
    }
    const toDelete = [...cosShardFiles].filter(f => !liveFiles.has(f));
    return { toDelete, liveFileCount: liveFiles.size };
}

/**
 * @param {object} p
 * @param {Set<string>} p.liveCommitSet
 * @param {Iterable<string>} p.cosRootFiles  COS 上 roots／text-roots 前缀下
 *        实际存在的相对文件名（如 "abc123....json"）
 * @returns {{ toDelete: string[] }}
 */
export function planRootsFileRetention({ liveCommitSet, cosRootFiles }) {
    const toDelete = [...cosRootFiles].filter(f => !liveCommitSet.has(commitFromRootFilename(f)));
    return { toDelete };
}

export function commitFromRootFilename(fname) {
    return fname.endsWith('.json') ? fname.slice(0, -'.json'.length) : fname;
}

/** ledger（roots-history）的序列化/反序列化：{ version: 1, updatedAt, history: [{commit, generatedAt}] } */
export function serializeRootsLedger(ledger) {
    return JSON.stringify({
        version: 1,
        updatedAt: new Date().toISOString(),
        history: ledger,
    });
}

export function parseRootsLedger(raw) {
    try {
        const doc = JSON.parse(raw);
        if (doc?.version !== 1 || !Array.isArray(doc?.history)) return [];
        return doc.history.filter(e => e && typeof e.commit === 'string' && typeof e.generatedAt === 'number');
    } catch {
        return [];
    }
}
