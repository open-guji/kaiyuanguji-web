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
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { createRequire } from 'module';
import { createHash } from 'crypto';
import { planOrphans, serializeOrphansTable, parseOrphansTable } from './h1-orphans.mjs';
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
