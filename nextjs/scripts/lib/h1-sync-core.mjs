/**
 * h1-sync-core.mjs — h1（内容哈希寻址）同步的共用引擎
 *
 * 从 sync-h1-to-cos.mjs（A3 第一期，entry 布局）抽出，供 entry 与 text（A3b，
 * 第二期）两条 sync 脚本共用，不再各写一份「三批按序上传 + 孤儿状态机」——
 * 任务书 A3b §一·2 点名要求：「建议抽成共用库，别复制一份」。
 *
 * 抽出的是纯粹的机制（走 COS、算 md5、分批、算孤儿该删/该留），业务差异
 * （本地目录在哪、哪些文件归哪一批、哪批走 7 天保留、孤儿表放哪个 key、
 * 缓存策略）全部由调用方通过 config 传入，本文件不认识 "entry" 或 "text"
 * 这两个词。
 *
 * 调用方保证（沿用第一期已验证的规矩）：
 *   - batches 数组顺序即上传顺序；前一批有失败就不进下一批（exit(2)，state 不落）。
 *   - 恰好一个 batch 标记 retain: true（即「保留 7 天再删」，如 entry），
 *     它的孤儿走 h1-orphans.mjs 的状态机，孤儿表放 config.orphansKey；
 *     其余 batch 的孤儿（本地已消失）当场删，没有保留期顾虑。
 *   - manifest／roots 批标 skipOrphans: true——S3（h1 版本根清单）把它们的孤儿
 *     判定改成「不被任何在用 root 引用」，不再是「本地没有就删」，另见本文件
 *     下方 runRootsRetention（算法在纯函数 h1-roots.mjs）。
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { createRequire } from 'module';
import { createHash } from 'crypto';
import { planOrphans, serializeOrphansTable, parseOrphansTable } from './h1-orphans.mjs';
import {
    planLiveCommits, planShardRetention, planRootsFileRetention,
    serializeRootsLedger, parseRootsLedger, commitFromRootFilename,
} from './h1-roots.mjs';
import { walk } from './h1-hash-common.mjs';

const require = createRequire(import.meta.url);

// walk() 从 h1-hash-common.mjs 转发：bundle-hashed*.mjs 与本文件都要递归收集
// 文件（前者收集打包源、后者收集要同步的产物），是同一个纯 fs 工具，不重复定义。
export { walk };

// ─── md5（带 mtime 缓存） ───

export function md5OfFile(path) {
    const hash = createHash('md5');
    hash.update(readFileSync(path));
    return hash.digest('hex');
}

export function md5WithCache(file, cache) {
    const entry = cache.get(file.relative);
    if (entry && entry.size === file.size && entry.mtimeMs === file.mtimeMs) {
        return { md5: entry.md5, hit: true };
    }
    const md5 = md5OfFile(file.full);
    cache.set(file.relative, { size: file.size, mtimeMs: file.mtimeMs, md5 });
    return { md5, hit: false };
}

export function loadHashCache(path) {
    try {
        if (!existsSync(path)) return new Map();
        const raw = JSON.parse(readFileSync(path, 'utf-8'));
        return new Map(Object.entries(raw));
    } catch (e) {
        console.warn(`  hash cache load failed (${e.message}), starting fresh`);
        return new Map();
    }
}

export function saveHashCache(path, cache) {
    try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify(Object.fromEntries(cache)), 'utf-8');
    } catch (e) {
        console.warn(`  hash cache save failed (${e.message}), ignored`);
    }
}

// ─── state（rel → md5）：只管「传不传」，孤儿年龄另有 orphans.json 管 ───
// state 格式 v3：files[rel] = md5。与 h1-orphans 的 v1 命名空间无关（不同文件）。

export function loadStateFile(path) {
    try {
        if (!existsSync(path)) return null;
        const raw = JSON.parse(readFileSync(path, 'utf-8'));
        if (raw?.version !== 3 || !raw?.files) return null;
        return new Map(Object.entries(raw.files));
    } catch (e) {
        console.warn(`  state load failed (${path}: ${e.message}), will rebuild`);
        return null;
    }
}

export function saveStateFile(path, stateMap) {
    try {
        mkdirSync(dirname(path), { recursive: true });
        const doc = { version: 3, savedAt: new Date().toISOString(), files: Object.fromEntries(stateMap) };
        writeFileSync(path, JSON.stringify(doc), 'utf-8');
    } catch (e) {
        console.warn(`  state save failed (${path}: ${e.message}), ignored`);
    }
}

// ─── 通用并发队列 ───

export async function runQueue(items, concurrency, worker, label) {
    const queue = [...items];
    let done = 0;
    const t0 = Date.now();
    const failures = [];
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        while (queue.length > 0) {
            const item = queue.shift();
            if (!item) return;
            try {
                await worker(item);
                done++;
                if (done % 200 === 0 || done === items.length) {
                    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
                    process.stdout.write(`\r  ${label}: ${done}/${items.length} (${elapsed}s)   `);
                }
            } catch (e) {
                failures.push({ item, err: e.message });
                console.error(`\n  ⚠ ${label} failed: ${JSON.stringify(item).slice(0, 80)} — ${e.message}`);
            }
        }
    });
    await Promise.all(workers);
    if (items.length > 0) process.stdout.write('\n');
    return { done, failures, elapsed: (Date.now() - t0) / 1000 };
}

function ext(name) {
    const i = name.lastIndexOf('.');
    return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

export function defaultContentTypeFor(relative) {
    return ext(relative) === 'json' ? 'application/json; charset=utf-8' : 'application/octet-stream';
}

/**
 * 纯计算：给定 state（rel → md5）与本地 md5，按 config.batches 顺序分好每批
 * 要传什么；不是「保留批」的孤儿收进即删清单，是「保留批」的孤儿收进候选清单
 * （老不老交给 planOrphans）。不联网、不改任何文件。
 */
export function planBatches(config, files, stateMap, localMd5) {
    const changed = (rel) => stateMap.get(rel) !== localMd5.get(rel);
    const batchOf = (rel) => config.batches.find(b => b.match(rel))?.key ?? null;

    const uploadsByBatch = config.batches.map(b => ({
        ...b,
        upload: files.filter(f => b.match(f.relative) && changed(f.relative)),
    }));
    const matchedRelSet = new Set(files.filter(f => batchOf(f.relative)).map(f => f.relative));
    const skipped = files.length - uploadsByBatch.reduce((s, b) => s + b.upload.length, 0);

    const localRelSet = new Set(files.map(f => f.relative));
    const retainOrphanCandidates = [];
    const immediateOrphansToDelete = [];

    for (const rel of stateMap.keys()) {
        if (localRelSet.has(rel)) continue; // 不是孤儿
        const key = batchOf(rel);
        if (!key) continue; // 不认识的 rel（如布局迁移期的旧前缀），不动
        const batch = config.batches.find(b => b.key === key);
        // S3（h1 版本根清单）：manifest／roots 批的孤儿不再是「本地没有就删」——
        // 本轮本地只反映"这一个 commit"的内容，旧 commit 的分片/roots 文件
        // 本来就不会出现在本地，用这里的逻辑判会把仍被"最近 N 个 root"引用的
        // 文件当场误删。这两批的孤儿改由 runRootsRetention（h1-roots.mjs）按
        // "在用 root 集合"另算，这里跳过，既不算保留候选也不算当场删除。
        if (batch.skipOrphans) continue;
        if (batch.retain) retainOrphanCandidates.push(rel);
        else immediateOrphansToDelete.push(rel);
    }

    return { uploadsByBatch, skipped, retainOrphanCandidates, immediateOrphansToDelete, matchedRelSet };
}

const CN_DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
function cnCount(n) {
    return CN_DIGITS[n] ?? String(n);
}

export function logPlan(plan) {
    const bytes = (arr) => (arr.reduce((s, f) => s + f.size, 0) / 1024 / 1024).toFixed(2);
    console.log(`\n  计划（${cnCount(plan.uploadsByBatch.length)}批按序）：`);
    for (const b of plan.uploadsByBatch) {
        console.log(`    ${b.label}: ${b.upload.length} 个（${bytes(b.upload)} MB）`);
    }
    console.log(`    跳过（未变）:      ${plan.skipped} 个`);
    console.log(`    保留期孤儿候选:    ${plan.retainOrphanCandidates.length} 个（老不老看 orphans.json，下面单独算）`);
    console.log(`    孤儿·当场删除:     ${plan.immediateOrphansToDelete.length} 个`);
    const totalUpload = plan.uploadsByBatch.reduce((s, b) => s + b.upload.length, 0);
    const totalUploadBytes = plan.uploadsByBatch.reduce((s, b) => s + b.upload.reduce((s2, f) => s2 + f.size, 0), 0);
    console.log(`    上传总计:          ${totalUpload} 个文件，${(totalUploadBytes / 1024 / 1024).toFixed(2)} MB`);
}

export function logOrphansPlan(label, orphansResult, tableSizeBefore) {
    console.log(`\n  ${label}：`);
    console.log(`    读到孤儿表:        ${tableSizeBefore} 条`);
    console.log(`    新增（本轮成孤儿）: ${orphansResult.added} 条`);
    console.log(`    移出（重新被引用）: ${orphansResult.reReferenced} 条`);
    console.log(`    保留（未满 7 天）:  ${orphansResult.toKeep.length} 条`);
    console.log(`    删除（已满 7 天）:  ${orphansResult.toDelete.length} 条`);
    console.log(`    写回后孤儿表:      ${orphansResult.newOrphansTable.size} 条`);
}

// ─── COS 客户端与重试包装的上传/删除/列举 ───

export function requireCosSdk() {
    try {
        return require('cos-nodejs-sdk-v5');
    } catch {
        console.error('❌ cos-nodejs-sdk-v5 not installed. Run: npm i -D cos-nodejs-sdk-v5');
        process.exit(1);
    }
}

export function createCosOps({ cos, bucket, region }) {
    async function listPrefixEtags(prefix) {
        const map = new Map();
        let marker = '';
        const stripQuotes = (s) => (s || '').replace(/^"|"$/g, '');
        while (true) {
            const res = await new Promise((resolveP, rejectP) => {
                cos.getBucket({ Bucket: bucket, Region: region, Prefix: prefix, Marker: marker, MaxKeys: 1000 },
                    (err, data) => err ? rejectP(err) : resolveP(data));
            });
            for (const obj of res.Contents || []) {
                map.set(obj.Key.slice(prefix.length), stripQuotes(obj.ETag));
            }
            if (res.IsTruncated === 'true' || res.IsTruncated === true) {
                marker = res.NextMarker || res.Contents[res.Contents.length - 1].Key;
            } else break;
        }
        return map;
    }

    async function uploadOne(file, key, cacheControl, contentType, attempt = 1) {
        try {
            return await new Promise((resolveP, rejectP) => {
                cos.putObject({
                    Bucket: bucket, Region: region, Key: key,
                    Body: readFileSync(file.full),
                    ContentType: contentType,
                    CacheControl: cacheControl,
                }, (err) => err ? rejectP(err) : resolveP());
            });
        } catch (e) {
            const transient = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network/i.test(e.message || '');
            if (transient && attempt < 4) {
                await new Promise(r => setTimeout(r, 500 * 2 ** attempt));
                return uploadOne(file, key, cacheControl, contentType, attempt + 1);
            }
            throw e;
        }
    }

    async function deleteOne(key, attempt = 1) {
        try {
            return await new Promise((resolveP, rejectP) => {
                cos.deleteObject({ Bucket: bucket, Region: region, Key: key }, (err) => err ? rejectP(err) : resolveP());
            });
        } catch (e) {
            const transient = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network/i.test(e.message || '');
            if (transient && attempt < 4) {
                await new Promise(r => setTimeout(r, 500 * 2 ** attempt));
                return deleteOne(key, attempt + 1);
            }
            throw e;
        }
    }

    async function getObjectText(key) {
        try {
            const res = await new Promise((resolveP, rejectP) => {
                cos.getObject({ Bucket: bucket, Region: region, Key: key },
                    (err, data) => err ? rejectP(err) : resolveP(data));
            });
            return res.Body.toString('utf-8');
        } catch (e) {
            const notFound = e?.statusCode === 404 || /NoSuchKey/i.test(e?.code || e?.message || '');
            if (notFound) return null;
            throw e;
        }
    }

    async function putObjectText(key, body, { contentType, cacheControl }) {
        return new Promise((resolveP, rejectP) => {
            cos.putObject({
                Bucket: bucket, Region: region, Key: key,
                Body: body, ContentType: contentType, CacheControl: cacheControl,
            }, (err) => err ? rejectP(err) : resolveP());
        });
    }

    return { listPrefixEtags, uploadOne, deleteOne, getObjectText, putObjectText };
}

/**
 * 跑一批上传；有任何失败就打印原因、退出（state 不落），不进下一批。
 * uploadOne(file) 由调用方绑好 key/cacheControl/contentType。
 */
export async function runUploadBatch(label, items, uploadOneForFile) {
    if (items.length === 0) {
        console.log(`  ${label}: 0 个，跳过`);
        return;
    }
    console.log(`  ${label}: 上传 ${items.length} 个...`);
    const r = await runQueue(items, 80, uploadOneForFile, label);
    if (r.failures.length > 0) {
        console.error(`\n❌ ${label} 有 ${r.failures.length}/${items.length} 个失败，不进下一批，state 不落。重跑整轮即可重试。`);
        process.exit(2);
    }
    console.log(`  ✓ ${label} 完成 ${r.done}/${items.length} in ${r.elapsed.toFixed(1)}s`);
}

/**
 * 孤儿表（保留期）读取：必须来自 COS（每次 CI 都是全新 checkout），对象不存在
 * 视为空表；其它读取失败一律中止整轮（不敢猜孤儿年龄，猜错的后果是误删）。
 */
export async function getOrphansTableFromCos(cosOps, key) {
    try {
        const raw = await cosOps.getObjectText(key);
        return raw === null ? new Map() : parseOrphansTable(raw);
    } catch (e) {
        console.error(`\n❌ 读取 ${key} 失败（非「不存在」）：${e.message}。不敢猜孤儿年龄，整轮中止，state 不落。`);
        process.exit(2);
    }
}

export async function putOrphansTableToCos(cosOps, key, table, { shortCacheControl }) {
    return cosOps.putObjectText(key, serializeOrphansTable(table), {
        contentType: 'application/json; charset=utf-8',
        cacheControl: shortCacheControl,
    });
}

// planOrphans／serializeOrphansTable／parseOrphansTable：调用方需要时直接
// `import ... from './h1-orphans.mjs'`，本文件已用它们实现上面两个函数，
// 不重复转发（转发一份 `export {...} from` 与本文件顶部的 `import {...}`
// 同名，多此一举）。

// ─── S3（h1 版本根清单）：manifest／roots 的「在用 root」孤儿清理 ───
//
// 与上面的 COS 直连函数不同，这里的编排函数吃一个抽象的 backend（4 个方法：
// readText/writeText/deleteKey/listPrefix），不是 cosOps 本身——这样同一套
// 编排逻辑既能接真实 COS（createCosRootsBackend），也能接一个纯本地 JSON
// 文件模拟的「假桶」（sync 脚本自己在 DRY_RUN 分支实现），dry-run 因此也能
// 真正跑一遍在用集合计算与清理决策，而不是像别处 dry-run 那样只模拟一部分。

/** 把 createCosOps() 的返回值包成 runRootsRetention 认识的 backend 形状。 */
export function createCosRootsBackend(cosOps) {
    return {
        readText: (key) => cosOps.getObjectText(key),
        writeText: (key, body, opts) => cosOps.putObjectText(key, body, opts),
        deleteKey: (key) => cosOps.deleteOne(key),
        listPrefix: async (prefix) => [...(await cosOps.listPrefixEtags(prefix)).keys()],
    };
}

async function readTextOrAbort(backend, key, label) {
    try {
        return await backend.readText(key);
    } catch (e) {
        console.error(`\n❌ 读取 ${label}（${key}）失败（非「不存在」）：${e.message}。不敢猜测，整轮中止，ledger 不落。`);
        process.exit(2);
    }
}

async function readPointerCommit(backend, key, label) {
    const raw = await readTextOrAbort(backend, key, label);
    if (raw === null) return null; // 没有旧指针（首次发布，或未配置测试站指针）
    try {
        const doc = JSON.parse(raw);
        if (typeof doc?.root !== 'string') return null; // 旧 schema（S3 之前）或异常内容，视同没有可用信息
        return commitFromRootFilename(doc.root);
    } catch {
        return null;
    }
}

async function readRootDocShards(backend, rootsPrefix, commit) {
    const raw = await readTextOrAbort(backend, `${rootsPrefix}${commit}.json`, `${commit} 的 root 文档`);
    if (raw === null) return {}; // 拉不到就当它没有分片贡献，不影响其余在用 commit 的保护范围
    try {
        const doc = JSON.parse(raw);
        return doc?.shards && typeof doc.shards === 'object' ? doc.shards : {};
    } catch {
        return {};
    }
}

/**
 * 算「在用 root 集合」（当前指针 + 测试站指针 + 最近 N 个）、清理不再被任何
 * 在用 root 引用的 manifest 分片与 roots 文件、把 ledger 收敛后写回。
 *
 * 必须在「entry/text、manifest 分片、roots 文件」三批全部上传成功之后、
 * 「翻转 pointerKey 指向新 commit」之前调用——这样：
 *   - 判定"在用"时读到的 currentPointerCommit 还是旧值，旧值与新值都会
 *     被保护，不会有任何一刻的读者拿到已被清理的分片/root；
 *   - 万一这一步失败中止，pointer 还没翻转，读者继续读旧版本，不受影响，
 *     重跑整轮即可重试（清理是幂等的：对象已经不存在时删除本来就该视同成功，
 *     COS deleteObject 对不存在的 key 本就不报错）。
 *
 * @param {object} backend  见上方 createCosRootsBackend；DRY_RUN 下调用方传
 *        本地 JSON 模拟的假 backend。
 * @param {object} config
 * @param {string} config.h1Prefix
 * @param {string} config.manifestSubdir   'manifest' | 'text-manifest'
 * @param {string} config.rootsSubdir      'roots' | 'text-roots'
 * @param {string} config.pointerKey       完整 COS key，如 `${h1Prefix}/manifest-root.json`
 * @param {string|null} [config.stagingPointerKey]  完整 COS key；未配置传 null/undefined（今天的常态）
 * @param {string} config.ledgerKey        完整 COS key，如 `${h1Prefix}/_meta/roots-history.json`
 * @param {number} [config.keepN]          默认 5
 * @param {string} config.newCommit        本轮新 commit key
 * @param {{shards: Record<string,string>}} config.newRootDoc  本轮已经在手的 root 文档（不必再读一次）
 * @param {string} config.shortCacheControl
 */
export async function runRootsRetention(backend, config) {
    const {
        h1Prefix, manifestSubdir, rootsSubdir, pointerKey, stagingPointerKey = null,
        ledgerKey, keepN = 5, newCommit, newRootDoc, shortCacheControl,
    } = config;

    const manifestPrefix = `${h1Prefix}/${manifestSubdir}/`;
    const rootsPrefix = `${h1Prefix}/${rootsSubdir}/`;

    const currentPointerCommit = await readPointerCommit(backend, pointerKey, '当前指针');
    const stagingPointerCommit = stagingPointerKey
        ? await readPointerCommit(backend, stagingPointerKey, '测试站指针')
        : null;

    const ledgerRaw = await readTextOrAbort(backend, ledgerKey, 'roots-history ledger');
    const ledger = ledgerRaw === null ? [] : parseRootsLedger(ledgerRaw);

    const { liveCommitSet, prunedLedger, retiredCommits } = planLiveCommits({
        ledger, newCommit, currentPointerCommit, stagingPointerCommit, keepN,
    });

    // 其余在用 commit（本轮新 commit 的 root 文档已经在手，不必再读一次）
    const otherLiveCommits = [...liveCommitSet].filter((c) => c !== newCommit);
    const otherShardsMaps = await Promise.all(
        otherLiveCommits.map((c) => readRootDocShards(backend, rootsPrefix, c))
    );
    const liveShardsMaps = [newRootDoc.shards, ...otherShardsMaps];

    const cosShardFiles = await backend.listPrefix(manifestPrefix);
    const { toDelete: shardsToDelete, liveFileCount } = planShardRetention({ liveShardsMaps, cosShardFiles });

    const cosRootFiles = await backend.listPrefix(rootsPrefix);
    const { toDelete: rootsToDelete } = planRootsFileRetention({ liveCommitSet, cosRootFiles });

    if (shardsToDelete.length > 0) {
        const r = await runQueue(shardsToDelete, 80, (rel) => backend.deleteKey(`${manifestPrefix}${rel}`), 'delete-manifest-shard-retired');
        if (r.failures.length > 0) {
            console.error(`\n❌ ${r.failures.length} 个 manifest 分片删除失败（已判定不再被任何在用 root 引用）。ledger 不落，重跑整轮即可重试（删除幂等）。`);
            process.exit(2);
        }
    }
    if (rootsToDelete.length > 0) {
        const r = await runQueue(rootsToDelete, 80, (rel) => backend.deleteKey(`${rootsPrefix}${rel}`), 'delete-root-retired');
        if (r.failures.length > 0) {
            console.error(`\n❌ ${r.failures.length} 个 roots 文件删除失败。ledger 不落，重跑整轮即可重试（删除幂等）。`);
            process.exit(2);
        }
    }

    await backend.writeText(ledgerKey, serializeRootsLedger(prunedLedger), {
        contentType: 'application/json; charset=utf-8',
        cacheControl: shortCacheControl,
    });

    return {
        currentPointerCommit,
        stagingPointerCommit,
        liveCommitCount: liveCommitSet.size,
        retiredCommitCount: retiredCommits.length,
        shardsLive: liveFileCount,
        shardsDeleted: shardsToDelete.length,
        rootsDeleted: rootsToDelete.length,
        ledgerSize: prunedLedger.length,
    };
}

export function logRootsRetentionPlan(label, stats) {
    console.log(`\n  ${label}：`);
    console.log(`    当前指针 commit:     ${stats.currentPointerCommit ?? '（无，首次发布）'}`);
    console.log(`    测试站指针 commit:   ${stats.stagingPointerCommit ?? '（未配置）'}`);
    console.log(`    在用 commit 数:       ${stats.liveCommitCount}（ledger 收敛后 ${stats.ledgerSize} 条）`);
    console.log(`    退出在用集合:         ${stats.retiredCommitCount} 个`);
    console.log(`    manifest 分片：在用 ${stats.shardsLive} 个，删除 ${stats.shardsDeleted} 个`);
    console.log(`    roots 文件：删除     ${stats.rootsDeleted} 个`);
}
