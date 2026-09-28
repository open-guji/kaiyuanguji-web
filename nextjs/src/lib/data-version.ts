/**
 * latest.json 里「拿什么当数据版本号」的唯一口径。
 *
 * `current/*?v=<x>` 的 cache-bust 与 search 分片路径 `v/<x>/search/` 都用它：
 * 优先 cacheKey（三仓 commit 合成键，sync-to-cos.mjs 写入，任一仓变就变），
 * 没有这个字段（旧数据、回滚到旧版）时回退 draft 的 commitId —— 新旧前端、
 * 新旧数据可以混着跑。见 overview#169。
 */
export interface LatestPointer {
    commitId?: string;
    cacheKey?: string;
}

export function dataVersionKey(latest: LatestPointer | null | undefined): string | undefined {
    return latest?.cacheKey || latest?.commitId || undefined;
}
