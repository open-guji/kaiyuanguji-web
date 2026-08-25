#!/usr/bin/env node
/**
 * sync-to-cos.mjs — 把 bundle-data.mjs 产出的 public/data/ 同步到腾讯云 COS
 *
 * 布局：
 *   cos://{bucket}/current/*                数据文件（entry/, items/, pagefind-fulltext/,
 *                                           promotions.json, recommended.json, meta.json,
 *                                           resource*.json, version.json）
 *                                           单副本，原地覆盖，按 ?v=<commit> CDN cache-bust
 *   cos://{bucket}/v/{shortCommit}/search/* search shards（每次重建，必须与当前 entry
 *                                           snapshot 一致 → commit 隔离避免 stale index）
 *   cos://{bucket}/latest.json              软指针 { commitId }，30s TTL，唯一需 PURGE
 *
 * 增量算法（state-driven）：
 *   1. 读 .next/.sync-state.json（上次 sync 成功时的 relative → {md5, size, mtimeMs}）
 *   2. 遍历本地 public/data/ 计算 MD5（mtime+size 命中 cache 直接复用，约 27s → 0s）
 *   3. 对每个本地文件：
 *        state 无 / md5 不同 → PUT current/X
 *        state 有且 md5 一致 → skip
 *   4. state 有但本地不存在 → DELETE current/X（孤儿清理）
 *   5. search shards 始终全量 PUT 到 v/{commit}/search/
 *   6. 最后写 latest.json
 *
 * state 丢失/损坏的 fallback：从 COS 拉 current/ 的 ETag 重建 state，
 * 跟旧 ListBucket 模式等价（~86s）。一次拉对后续 sync 永久受益。
 *
 * 环境变量：
 *   COS_SECRET_ID       (必填) 腾讯云 SecretId
 *   COS_SECRET_KEY      (必填) 腾讯云 SecretKey
 *   COS_BUCKET          (必填) 桶名，如 kyg-data-1300xxxxxx
 *   COS_REGION          (可选) 默认 ap-shanghai
 *   COS_PATH_PREFIX     (可选) 桶内根前缀，默认空字符串
 *   DRY_RUN             (可选) 设为 1 只打印不上传
 *   SYNC_REBUILD_STATE  (可选) 设为 1 强制从 COS 列文件重建 state（state 文件可疑时用）
 *
 * 用法：
 *   node scripts/sync-to-cos.mjs              # 增量同步
 *   DRY_RUN=1 node scripts/sync-to-cos.mjs    # 干跑
 *   SYNC_REBUILD_STATE=1 node scripts/sync-to-cos.mjs  # 重建本地 state
 */

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve, dirname, posix } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { createHash } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// ─── 加载 .env.local（不存在则跳过，CI 里用真实环境变量） ───
//
// 极简 dotenv：只处理 KEY=value，忽略空行 / # 开头。
// 已经存在于 process.env 的优先（避免 .env.local 误覆盖 CI 注入）。
const envLocal = resolve(__dirname, '..', '.env.local');
if (existsSync(envLocal)) {
    for (const line of readFileSync(envLocal, 'utf-8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (!m || line.trim().startsWith('#')) continue;
        const [, k, vRaw] = m;
        const v = vRaw.replace(/^['"]|['"]$/g, '');
        if (!(k in process.env)) process.env[k] = v;
    }
}

// ─── 配置 ───

const DATA_DIR = resolve(__dirname, '..', 'public', 'data');
const LATEST_FILE = resolve(__dirname, '..', 'public', 'latest.json');

const SECRET_ID = process.env.COS_SECRET_ID;
const SECRET_KEY = process.env.COS_SECRET_KEY;
const BUCKET = process.env.COS_BUCKET;
const REGION = process.env.COS_REGION || 'ap-shanghai';
const PATH_PREFIX = (process.env.COS_PATH_PREFIX || '').replace(/^\/+|\/+$/g, '');
const DRY_RUN = process.env.DRY_RUN === '1';
const REBUILD_STATE = process.env.SYNC_REBUILD_STATE === '1';

// 哪些子目录走 commit 隔离 v/<commit>/ — 主要是 search shards：
// 倒排索引文件互相关联，必须跟当前 entry snapshot 一致；进入 current/ 会导致
// 部分 client 拉到混合版本 → ID 不存在 / 旧 ID 取新 entry 等 bug。
const ISOLATED_DIRS = new Set(['search']);

// ─── 校验 ───

if (!existsSync(DATA_DIR)) {
    console.error(`❌ ${DATA_DIR} not found. Run bundle-data.mjs first.`);
    process.exit(1);
}
if (!existsSync(LATEST_FILE)) {
    console.error(`❌ ${LATEST_FILE} not found. Re-run bundle-data.mjs (latest.json now produced alongside version.json).`);
    process.exit(1);
}

const latest = JSON.parse(readFileSync(LATEST_FILE, 'utf-8'));
const shortCommit = latest.commitId;
if (!shortCommit || shortCommit === 'unknown') {
    console.error('❌ latest.json has no usable commitId. Aborting.');
    process.exit(1);
}

if (!DRY_RUN) {
    for (const [name, val] of Object.entries({ COS_SECRET_ID: SECRET_ID, COS_SECRET_KEY: SECRET_KEY, COS_BUCKET: BUCKET })) {
        if (!val) {
            console.error(`❌ Missing env ${name}`);
            process.exit(1);
        }
    }
}

// ─── 收集文件 ───

function walk(dir, base = dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const stat = statSync(full);
        if (stat.isDirectory()) {
            // 不能用 out.push(...walk(...))：spread 把每个元素当调用参数压栈，
            // entry/ 超过 ~10 万个文件后直接 RangeError: Maximum call stack
            // size exceeded（2026-08-25 大批量升格后首次触发）。
            for (const f of walk(full, base)) out.push(f);
        } else {
            const relative = full.slice(base.length + 1).split(/[\\/]/).join('/');
            // mtimeMs: 取整到毫秒避免 fs 精度抖动；配合 bundle 端的 writeIfChanged
            // 未变文件 mtime 不刷新，cache hit 跳过 md5 重算（节省 5-7 min / sync）
            out.push({ full, relative, size: stat.size, mtimeMs: Math.floor(stat.mtimeMs) });
        }
    }
    return out;
}

const files = walk(DATA_DIR);
const totalBytes = files.reduce((s, f) => s + f.size, 0);

function joinKey(...parts) {
    return parts.filter(Boolean).map(p => p.replace(/^\/+|\/+$/g, '')).join('/');
}

const currentPrefix = joinKey(PATH_PREFIX, 'current');
const versionPrefix = joinKey(PATH_PREFIX, 'v', shortCommit);  // 仅 search shards 用
const latestKey = joinKey(PATH_PREFIX, 'latest.json');

/** 给本地相对路径决定它的 COS key（数据走 current/，search 走 v/<commit>/）。 */
function keyFor(relative) {
    const topDir = relative.split('/')[0];
    if (ISOLATED_DIRS.has(topDir)) {
        return `${versionPrefix}/${relative}`;
    }
    return `${currentPrefix}/${relative}`;
}

const isolatedFiles = files.filter(f => ISOLATED_DIRS.has(f.relative.split('/')[0]));
const sharedFiles = files.filter(f => !ISOLATED_DIRS.has(f.relative.split('/')[0]));

console.log(`\nsync-to-cos`);
console.log(`  bucket:   ${BUCKET}`);
console.log(`  region:   ${REGION}`);
console.log(`  source:   ${DATA_DIR}`);
console.log(`  shared:   cos://${BUCKET}/${currentPrefix}/  (${sharedFiles.length} files, ${(sharedFiles.reduce((s,f)=>s+f.size,0)/1024/1024).toFixed(1)} MB — 增量)`);
console.log(`  isolated: cos://${BUCKET}/${versionPrefix}/  (${isolatedFiles.length} files, ${(isolatedFiles.reduce((s,f)=>s+f.size,0)/1024/1024).toFixed(1)} MB — 全量)`);
console.log(`  latest:   cos://${BUCKET}/${latestKey}  → { commitId: "${shortCommit}" }`);
console.log(`  mode:     ${DRY_RUN ? 'DRY RUN' : 'UPLOAD'}\n`);

if (DRY_RUN) {
    console.log('— sample (first 5 of each) —');
    for (const f of sharedFiles.slice(0, 5)) {
        console.log(`  shared:   ${keyFor(f.relative)}  (${f.size} B)`);
    }
    for (const f of isolatedFiles.slice(0, 5)) {
        console.log(`  isolated: ${keyFor(f.relative)}  (${f.size} B)`);
    }
    console.log('\n(dry run, nothing uploaded)\n');
    process.exit(0);
}

// ─── 上传 ───

let COS;
try {
    COS = require('cos-nodejs-sdk-v5');
} catch {
    console.error('❌ cos-nodejs-sdk-v5 not installed. Run: npm i -D cos-nodejs-sdk-v5');
    process.exit(1);
}

// FileParallelLimit + ChunkParallelLimit 提升整体并发；UserAgent 便于在 COS 访问日志里识别
const cos = new COS({
    SecretId: SECRET_ID,
    SecretKey: SECRET_KEY,
    FileParallelLimit: 80,
    ChunkParallelLimit: 8,
    Timeout: 60 * 1000,
});

function ext(name) {
    const i = name.lastIndexOf('.');
    return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

function contentTypeFor(relative) {
    switch (ext(relative)) {
        case 'json': return 'application/json; charset=utf-8';
        case 'txt':  return 'text/plain; charset=utf-8';
        case 'md':   return 'text/markdown; charset=utf-8';
        case 'png':  return 'image/png';
        case 'jpg':
        case 'jpeg': return 'image/jpeg';
        case 'svg':  return 'image/svg+xml';
        case 'webp': return 'image/webp';
        default:     return 'application/octet-stream';
    }
}

// v/{commit}/search/ 下文件不可变（永远新 commit），1 年长缓存
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
// current/ 下文件按 ?v=<commit> cache-bust，所以也按 immutable 缓存（不同 ?v 视为不同对象）
const SHARED_CACHE = 'public, max-age=31536000, immutable';
// latest.json 是软指针，30 秒
const LATEST_CACHE = 'public, max-age=30, must-revalidate';

// 小文件阈值：低于此走 putObject（轻量单 PUT，零事件循环开销）；
// 高于此走 uploadFile（自动 multipart）。
const SMALL_FILE_THRESHOLD = 5 * 1024 * 1024;  // 5 MB

async function uploadOne({ full, relative, size }, attempt = 1) {
    const key = keyFor(relative);
    const cacheControl = ISOLATED_DIRS.has(relative.split('/')[0]) ? IMMUTABLE_CACHE : SHARED_CACHE;
    try {
        if (size <= SMALL_FILE_THRESHOLD) {
            return await new Promise((resolveP, rejectP) => {
                cos.putObject({
                    Bucket: BUCKET,
                    Region: REGION,
                    Key: key,
                    Body: readFileSync(full),
                    ContentType: contentTypeFor(relative),
                    CacheControl: cacheControl,
                }, (err) => err ? rejectP(err) : resolveP({ key, size }));
            });
        }
        return await new Promise((resolveP, rejectP) => {
            cos.uploadFile({
                Bucket: BUCKET,
                Region: REGION,
                Key: key,
                FilePath: full,
                ContentType: contentTypeFor(relative),
                CacheControl: cacheControl,
                SliceSize: 1024 * 1024 * 10,
                onProgress: () => {},
            }, (err) => err ? rejectP(err) : resolveP({ key, size }));
        });
    } catch (e) {
        const transient = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network/i.test(e.message || '');
        if (transient && attempt < 4) {
            await new Promise(r => setTimeout(r, 500 * 2 ** attempt));
            return uploadOne({ full, relative, size }, attempt + 1);
        }
        throw e;
    }
}

async function deleteOne(key, attempt = 1) {
    try {
        return await new Promise((resolveP, rejectP) => {
            cos.deleteObject({
                Bucket: BUCKET, Region: REGION, Key: key,
            }, (err) => err ? rejectP(err) : resolveP());
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

async function uploadLatest() {
    return new Promise((resolveP, rejectP) => {
        cos.putObject({
            Bucket: BUCKET,
            Region: REGION,
            Key: latestKey,
            Body: readFileSync(LATEST_FILE),
            ContentType: 'application/json; charset=utf-8',
            CacheControl: LATEST_CACHE,
        }, (err) => err ? rejectP(err) : resolveP());
    });
}

/**
 * List 一个 prefix 下所有对象的 key + etag —— 用于增量 sync。
 *
 * 用法：
 *   1. 当前 versionPrefix：判断哪些 key 已经传过（断点续传）
 *   2. 上一个 commit 的 versionPrefix：判断哪些 key 内容跟本地一样（→ copy-object）
 *
 * ETag 对单 PUT 对象 = `"hex_md5"`（带双引号）。multipart 上传会变格式，
 * 但 sync-to-cos.mjs 对小文件走 putObject（单 PUT），ETag 即文件 MD5。
 */
async function listPrefixEtags(prefix) {
    const map = new Map();  // relativeKey → md5 hex (no quotes)
    let marker = '';
    let pages = 0;
    const stripQuotes = (s) => (s || '').replace(/^"|"$/g, '');
    while (true) {
        const res = await new Promise((resolveP, rejectP) => {
            cos.getBucket({
                Bucket: BUCKET, Region: REGION,
                Prefix: prefix,
                Marker: marker,
                MaxKeys: 1000,
            }, (err, data) => err ? rejectP(err) : resolveP(data));
        });
        for (const obj of res.Contents || []) {
            const rel = obj.Key.slice(prefix.length);
            map.set(rel, stripQuotes(obj.ETag));
        }
        pages++;
        if (res.IsTruncated === 'true' || res.IsTruncated === true) {
            marker = res.NextMarker || res.Contents[res.Contents.length - 1].Key;
        } else {
            break;
        }
    }
    return { map, pages };
}

/** 读取 cos://bucket/latest.json 的 commitId，无 → null（首次发布） */
async function getPreviousCommitId() {
    try {
        const res = await new Promise((resolveP, rejectP) => {
            cos.getObject({ Bucket: BUCKET, Region: REGION, Key: latestKey },
                (err, data) => err ? rejectP(err) : resolveP(data));
        });
        const body = JSON.parse(res.Body.toString('utf-8'));
        return body.commitId || null;
    } catch {
        return null;
    }
}

/** 本地 MD5（hex）。文件 < 10 MB 一次读完，>= 10 MB 流式（极少触发）。 */
function md5OfFile(path, size) {
    const hash = createHash('md5');
    hash.update(readFileSync(path));
    return hash.digest('hex');
}

// ─── MD5 缓存（mtime + size keyed） ───
// 配合 bundle-data.mjs 的 writeIfChanged 使用：未变文件 mtime/size 不变 →
// 直接复用上次的 md5，跳过 readFile + hash（232K 文件能从 7-8 min 压到 < 30s）。
// Cache miss 时正常算 md5 并写回缓存。
const HASH_CACHE_FILE = resolve(__dirname, '..', '.next', '.sync-hash-cache.json');

// ─── sync-state file（上次成功 sync 的 remote 状态） ───
// 格式：{ version: 2, files: { "entry/X.json": "md5hex", ... } }
// 注意 key 是本地相对路径，不是 COS key（COS key 由 keyFor 派生）。
// 增量同步靠这个判断：local md5 vs state md5 → put/skip/delete。
const SYNC_STATE_FILE = resolve(__dirname, '..', '.next', '.sync-state.json');

function loadSyncState() {
    try {
        if (!existsSync(SYNC_STATE_FILE)) return null;
        const raw = JSON.parse(readFileSync(SYNC_STATE_FILE, 'utf-8'));
        if (raw?.version !== 2 || !raw?.files) return null;
        return new Map(Object.entries(raw.files));
    } catch (e) {
        console.warn(`  sync-state load failed (${e.message}), will rebuild`);
        return null;
    }
}

function saveSyncState(stateMap) {
    try {
        mkdirSync(dirname(SYNC_STATE_FILE), { recursive: true });
        const doc = { version: 2, savedAt: new Date().toISOString(), files: Object.fromEntries(stateMap) };
        writeFileSync(SYNC_STATE_FILE, JSON.stringify(doc), 'utf-8');
    } catch (e) {
        console.warn(`  sync-state save failed (${e.message}), ignored (next sync will rebuild)`);
    }
}

/** 从 COS 列 current/ 所有 key+etag，构造 state map（fallback：state 丢失或 --rebuild）。 */
async function rebuildStateFromCos() {
    const stateMap = new Map();
    // 只重建 shared current/，isolated v/<commit>/search/ 每次必传不需要 state
    const { map, pages } = await listPrefixEtags(currentPrefix + '/');
    for (const [rel, md5] of map) {
        stateMap.set(rel, md5);
    }
    console.log(`  rebuilt state from cos: ${stateMap.size} keys in ${pages} pages`);
    return stateMap;
}

function loadHashCache() {
    try {
        if (!existsSync(HASH_CACHE_FILE)) return new Map();
        const raw = JSON.parse(readFileSync(HASH_CACHE_FILE, 'utf-8'));
        return new Map(Object.entries(raw));
    } catch (e) {
        console.warn(`  hash cache load failed (${e.message}), starting fresh`);
        return new Map();
    }
}

function saveHashCache(cache) {
    try {
        mkdirSync(dirname(HASH_CACHE_FILE), { recursive: true });
        const obj = Object.fromEntries(cache);
        writeFileSync(HASH_CACHE_FILE, JSON.stringify(obj), 'utf-8');
    } catch (e) {
        console.warn(`  hash cache save failed (${e.message}), ignored`);
    }
}

/** 查 cache，hit 返回缓存的 md5；miss 时计算并写回。 */
function md5WithCache(file, cache) {
    const key = file.relative;
    const entry = cache.get(key);
    if (entry && entry.size === file.size && entry.mtimeMs === file.mtimeMs) {
        return { md5: entry.md5, hit: true };
    }
    const md5 = md5OfFile(file.full, file.size);
    cache.set(key, { size: file.size, mtimeMs: file.mtimeMs, md5 });
    return { md5, hit: false };
}

/** COS 服务端 copy-object —— 不走带宽，按 PUT 计费。 */
async function copyOne(srcKey, destKey, attempt = 1) {
    try {
        return await new Promise((resolveP, rejectP) => {
            cos.putObjectCopy({
                Bucket: BUCKET, Region: REGION,
                Key: destKey,
                // CopySource 走 HTTP header，含 CJK / 空格等会被 Node http 拒绝
                // （"Invalid character in header content"）。按 RFC 3986 编码路径，
                // 保留 '/' 分隔符。
                CopySource: `${BUCKET}.cos.${REGION}.myqcloud.com/${encodeURI(srcKey)}`,
            }, (err) => err ? rejectP(err) : resolveP());
        });
    } catch (e) {
        const transient = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network/i.test(e.message || '');
        if (transient && attempt < 4) {
            await new Promise(r => setTimeout(r, 500 * 2 ** attempt));
            return copyOne(srcKey, destKey, attempt + 1);
        }
        throw e;
    }
}

async function runQueue(items, concurrency, worker, label) {
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
                if (done % 100 === 0 || done === items.length) {
                    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
                    process.stdout.write(`\r  ${label}: ${done}/${items.length} (${elapsed}s)   `);
                }
            } catch (e) {
                failures.push({ item, err: e.message });
                console.error(`\n  ⚠ ${label} failed: ${JSON.stringify(item).slice(0,80)} — ${e.message}`);
            }
        }
    });
    await Promise.all(workers);
    if (items.length > 0) process.stdout.write('\n');
    return { done, failures, elapsed: (Date.now() - t0) / 1000 };
}

async function main() {
    const CONCURRENCY = 80;

    // ── Step 1: 加载或重建 state ──
    let stateMap = REBUILD_STATE ? null : loadSyncState();
    if (!stateMap) {
        if (REBUILD_STATE) {
            console.log(`  SYNC_REBUILD_STATE=1: ignoring local state, listing COS...`);
        } else {
            console.log(`  no local sync-state, listing COS to rebuild...`);
        }
        const tList = Date.now();
        stateMap = await rebuildStateFromCos();
        console.log(`  (${((Date.now() - tList) / 1000).toFixed(1)}s)`);
    } else {
        console.log(`  loaded sync-state: ${stateMap.size} known keys (skip listing)`);
    }

    // ── Step 2: 计算本地 MD5 ──
    console.log(`  computing local MD5s for ${files.length} files (mtime cache enabled)...`);
    const tHash = Date.now();
    const hashCache = loadHashCache();
    const cacheSizeBefore = hashCache.size;
    let cacheHits = 0;
    const localMd5 = new Map();  // relative → md5
    for (const f of files) {
        const { md5, hit } = md5WithCache(f, hashCache);
        localMd5.set(f.relative, md5);
        if (hit) cacheHits++;
    }
    saveHashCache(hashCache);
    console.log(`  hashed ${files.length} files in ${((Date.now() - tHash) / 1000).toFixed(1)}s (cache hit ${cacheHits}/${files.length}, cache size ${cacheSizeBefore}→${hashCache.size})`);

    // ── Step 3: 分流 ──
    // shared: 用 state 增量
    const sharedToUpload = [];
    let sharedSkipped = 0;
    for (const f of sharedFiles) {
        const stateMd5 = stateMap.get(f.relative);
        if (stateMd5 === localMd5.get(f.relative)) {
            sharedSkipped++;
        } else {
            sharedToUpload.push(f);
        }
    }
    // isolated: 每次必传到新 v/<commit>/search/
    const isolatedToUpload = isolatedFiles;
    // orphan: state 里有但本地没了
    const localRelSet = new Set(files.map(f => f.relative));
    const orphanKeys = [];
    for (const rel of stateMap.keys()) {
        // 只处理 shared 的孤儿（isolated 走 commit 隔离，旧 v/<oldcommit>/ 通过别的方式清理）
        if (ISOLATED_DIRS.has(rel.split('/')[0])) continue;
        if (!localRelSet.has(rel)) orphanKeys.push(rel);
    }

    const sharedUploadBytes = sharedToUpload.reduce((s, f) => s + f.size, 0);
    const isolatedUploadBytes = isolatedToUpload.reduce((s, f) => s + f.size, 0);
    console.log(`  plan:`);
    console.log(`    shared:   ${sharedSkipped} skip · ${sharedToUpload.length} upload (${(sharedUploadBytes / 1024 / 1024).toFixed(1)} MB) · ${orphanKeys.length} delete`);
    console.log(`    isolated: ${isolatedToUpload.length} upload (${(isolatedUploadBytes / 1024 / 1024).toFixed(1)} MB) — 全量到 v/${shortCommit}/`);

    const allFailures = [];

    // ── Step 4a: 上传 shared 增量 ──
    if (sharedToUpload.length > 0) {
        console.log(`  uploading shared...`);
        const r = await runQueue(sharedToUpload, CONCURRENCY, uploadOne, 'shared-up');
        console.log(`  ✓ shared uploaded ${r.done}/${sharedToUpload.length} in ${r.elapsed.toFixed(1)}s`);
        allFailures.push(...r.failures);
    }

    // ── Step 4b: 上传 isolated 全量 ──
    if (isolatedToUpload.length > 0) {
        console.log(`  uploading isolated (search shards)...`);
        const r = await runQueue(isolatedToUpload, CONCURRENCY, uploadOne, 'isolated-up');
        console.log(`  ✓ isolated uploaded ${r.done}/${isolatedToUpload.length} in ${r.elapsed.toFixed(1)}s`);
        allFailures.push(...r.failures);
    }

    // ── Step 4c: 删 orphan ──
    if (orphanKeys.length > 0) {
        console.log(`  deleting orphans...`);
        const r = await runQueue(orphanKeys, CONCURRENCY,
            (rel) => deleteOne(`${currentPrefix}/${rel}`), 'delete');
        console.log(`  ✓ deleted ${r.done}/${orphanKeys.length} in ${r.elapsed.toFixed(1)}s`);
        allFailures.push(...r.failures);
    }

    if (allFailures.length > 0) {
        console.error(`\n❌ ${allFailures.length} op(s) failed. NOT updating latest.json or state. Re-run to retry.`);
        process.exit(2);
    }

    // ── Step 5: 写 state（成功后才更新，失败保留旧 state 让下次重试） ──
    const newState = new Map();
    for (const f of sharedFiles) {
        newState.set(f.relative, localMd5.get(f.relative));
    }
    saveSyncState(newState);
    console.log(`  ✓ sync-state saved (${newState.size} keys)`);

    // ── Step 6: latest.json ──
    console.log(`\n  writing latest.json → cos://${BUCKET}/${latestKey}`);
    await uploadLatest();
    console.log(`  ✓ latest.json now points to commit ${shortCommit}`);

    console.log(`\n✅ sync-to-cos complete\n`);
}

main().catch(err => {
    console.error(`\n❌ Fatal: ${err.message}`);
    process.exit(1);
});
