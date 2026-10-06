/**
 * latest-cache-key.mjs — latest.json 的 cacheKey（current/ 的 ?v= 与 search 分片路径用）
 *
 * 此前 `?v=` 与 `v/<x>/search/` 只用 draft 仓的 commitId。只有 production 仓或
 * book-text 变的那次发布，commitId 不变 → URL 不变，而 current/* 与 search 分片
 * 都是 1 年 immutable 缓存，CDN 与浏览器就一直吐旧版（overview#169，DQ 实测
 * 抽样 18% 条目命中旧缓存）。
 *
 * 改用三仓合成键：直接复用 dataCommitKey（与 roots/<key>.json 同一函数、同一
 * 输入），任一仓变了键就变。
 *
 * 10-01 起再并进「打包产物的内容摘要」：三仓 commit 没变、网站打包脚本改了，产物变了键也要变
 * （见 data-content-digest.mjs）。所以 cacheKey 不再恒等于 h1 root 文件名（只在产物没变时相同）。
 *
 * 纯函数、不读写文件，sync-to-cos.mjs 用它往 latest.json 补字段，jest 直接测。
 */

import { createHash } from 'node:crypto';
import { dataCommitKey } from './h1-hash-common.mjs';

/**
 * 由 latest.json（bundle-data.mjs 产出的字段）算 cacheKey。
 * commitId 位取完整 hash（fullCommitId；overview#432 起即正式仓 commit），缺时退回 12 位 commitId；缺省字段按
 * bundle-hashed*.mjs 的约定记 'unknown'，保证与 version.json 算出的 root key 一致。
 */
export function latestCacheKey(latest, contentDigest) {
    const key = dataCommitKey({
        commitId: latest.fullCommitId || latest.commitId || 'unknown',
        productionCommitId: latest.productionCommitId || 'unknown',
        textCommitId: latest.textCommitId || 'unknown',
    });
    // 没给产物摘要（旧调用方、测试）：与以前完全一致
    if (!contentDigest) return key;
    return createHash('sha256').update(`${key}\0${contentDigest}`).digest('hex').slice(0, 16);
}

/**
 * 返回补上 cacheKey（和 contentDigest，留作排查）的新 latest 对象（不改入参）。
 * contentDigest：打包产物的内容摘要（lib/data-content-digest.mjs）。三仓 commit 没变、网站打包脚本改了导致产物变了，
 * 键也要变，否则 current/<文件>?v=<键> 的 URL 不变，CDN 吐旧产物（见 data-content-digest.mjs 头注释）。
 */
export function withCacheKey(latest, contentDigest) {
    const out = { ...latest, cacheKey: latestCacheKey(latest, contentDigest) };
    if (contentDigest) out.contentDigest = contentDigest;
    return out;
}
