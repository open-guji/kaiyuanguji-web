/**
 * item-changes.mjs — 两个 h1 版本根清单之间「哪些条目变了」（W2-3，31 卡 §A.6）。
 *
 * 条目页只渲染本条目 JSON 里的东西（§A.6 第 3 条），所以「哪些页要失效」恰好等于
 * 「哪些条目的内容哈希变了」。h1 已经按内容哈希寻址：
 *   root.shards[后缀] → 分片文件哈希；分片 { id → 条目哈希 }
 * 分片哈希相同 ⇒ 分片里所有条目都没变，整片跳过；只有分片哈希不同的，才逐条比。
 * 29 卡实测均值每次发布约 831 条变化，落在几百个分片里。
 *
 * 纯函数，不做 I/O；取文件由 scripts/item-changes.mjs 负责。
 */

/**
 * 两个 root 文档里分片哈希不同的分片后缀（含只在一边出现的）。
 * @param {{shards: Record<string,string>}|null} oldRoot  null ＝ 首次发布，全部算新增
 * @param {{shards: Record<string,string>}} newRoot
 * @returns {string[]} 排好序的分片后缀
 */
export function changedShardKeys(oldRoot, newRoot) {
    const a = oldRoot?.shards ?? {};
    const b = newRoot.shards ?? {};
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].filter((k) => a[k] !== b[k]).sort();
}

/**
 * 同一个分片的新旧两版 { id → 条目哈希 } 比出三类 id。
 * @param {Record<string,string>|null} oldShard  null ＝ 旧版没有这个分片
 * @param {Record<string,string>|null} newShard  null ＝ 新版没有这个分片
 */
export function diffShard(oldShard, newShard) {
    const a = oldShard ?? {};
    const b = newShard ?? {};
    const added = [], changed = [], removed = [];
    for (const [id, h] of Object.entries(b)) {
        if (!(id in a)) added.push(id);
        else if (a[id] !== h) changed.push(id);
    }
    for (const id of Object.keys(a)) if (!(id in b)) removed.push(id);
    return { added, changed, removed };
}

/** 汇总多个分片的 diffShard 结果，各类 id 排序去重 */
export function mergeDiffs(diffs) {
    const out = { added: new Set(), changed: new Set(), removed: new Set() };
    for (const d of diffs) for (const k of Object.keys(out)) for (const id of d[k]) out[k].add(id);
    const sorted = (s) => [...s].sort();
    return { added: sorted(out.added), changed: sorted(out.changed), removed: sorted(out.removed) };
}
