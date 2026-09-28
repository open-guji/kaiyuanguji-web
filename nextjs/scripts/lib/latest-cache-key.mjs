/**
 * latest-cache-key.mjs — latest.json 的 cacheKey（current/ 的 ?v= 与 search 分片路径用）
 *
 * 此前 `?v=` 与 `v/<x>/search/` 只用 draft 仓的 commitId。只有 production 仓或
 * book-text 变的那次发布，commitId 不变 → URL 不变，而 current/* 与 search 分片
 * 都是 1 年 immutable 缓存，CDN 与浏览器就一直吐旧版（overview#169，DQ 实测
 * 抽样 18% 条目命中旧缓存）。
 *
 * 改用三仓合成键：直接复用 dataCommitKey（与 roots/<key>.json 同一函数、同一
 * 输入），任一仓变了键就变；同一次发布的 cacheKey 与 h1 root 文件名一致，方便
 * 排查时对齐。
 *
 * 纯函数、不读写文件，sync-to-cos.mjs 用它往 latest.json 补字段，jest 直接测。
 */

import { dataCommitKey } from './h1-hash-common.mjs';

/**
 * 由 latest.json（bundle-data.mjs 产出的字段）算 cacheKey。
 * draft 用完整 hash（fullCommitId），缺时退回 12 位 commitId；缺省字段按
 * bundle-hashed*.mjs 的约定记 'unknown'，保证与 version.json 算出的 root key 一致。
 */
export function latestCacheKey(latest) {
    return dataCommitKey({
        commitId: latest.fullCommitId || latest.commitId || 'unknown',
        productionCommitId: latest.productionCommitId || 'unknown',
        textCommitId: latest.textCommitId || 'unknown',
    });
}

/** 返回补上 cacheKey 的新 latest 对象（不改入参）。 */
export function withCacheKey(latest) {
    return { ...latest, cacheKey: latestCacheKey(latest) };
}
