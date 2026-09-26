#!/usr/bin/env node
/**
 * sync-h1-to-cos.mjs — 把 bundle-hashed.mjs 产出的 public/data-h1/ 同步到腾讯云 COS
 *
 * 与 sync-to-cos.mjs（现行 current/ 布局）并行、互不影响：上传目标是**同一个新加坡桶**
 * 的新前缀 `h1/`，不改、不清、不读现行 `current/`／`v/` 前缀下的任何对象。
 *
 * 布局：
 *   cos://{bucket}/h1/entry/<id>.<hash8>.json    内容寻址，Cache-Control: immutable 1 年
 *   cos://{bucket}/h1/manifest/<后缀2位>.json     id→hash8 分片，短缓存
 *   cos://{bucket}/h1/manifest-root.json          分片数/生成时间/数据 commit，短缓存
 *
 * 三批按序上传（2026-09-26 协调者验收第二轮定）：
 *   ① 全部新增/变化的 entry ② 变化的 manifest 分片 ③ manifest-root.json
 * 前一批有任何失败就不进下一批：exit(2)，state 不落，整轮重试。
 * 原因：分片一旦先于它指向的新 entry 上线，读者按分片给的哈希去拉 entry 会 404；
 * root 一旦先于分片上线，读者可能读到「分片数对不上」的过渡态。反过来——entry
 * 先传、root 最后传——任何时刻线上的 root+分片+entry 要么是旧的一整套一致状态，
 * 要么是新的一整套一致状态，不会有「新分片指向的 entry 还没到」这种中间态。
 *
 * entry 孤儿保留 7 天（同轮定）：旧 entry 不能当场删——分片有短缓存（60–300s）、
 * 页面内存缓存更久，都可能还指向旧哈希；当场删会让这些读者拿到 404 而不是回退
 * 到现行路径（cos-storage.ts 的 h1 分支 404 时直接判条目不存在，不会自动切回
 * current/）。manifest 分片的孤儿没有这个顾虑（分片路径固定、不含哈希，一旦
 * 本地没有就是真的没有任何 id 落在这个分片了）照旧当场删。
 *
 * 增量算法：state-driven MD5 diff，state 缺失/损坏时从 COS 拉 ETag + LastModified
 * 重建；entry/ 的相对路径已经把内容哈希编进文件名，内容一变路径就变，旧路径经
 * bundle-hashed.mjs 的垃圾回收从本地消失，在 diff 里落入「orphan」分支，按
 * lastModified 决定是否已过 7 天保留期。
 *
 * 环境变量：与 sync-to-cos.mjs 相同的 COS_SECRET_ID / COS_SECRET_KEY / COS_BUCKET /
 * COS_REGION（默认 ap-singapore，与现行 h1 桶保持一致）／DRY_RUN／SYNC_REBUILD_STATE。
 *
 * 用法：
 *   node scripts/sync-h1-to-cos.mjs
 *   DRY_RUN=1 node scripts/sync-h1-to-cos.mjs
 */

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { createHash } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// ─── 加载 .env.local（与 sync-to-cos.mjs 同一套极简 dotenv） ───
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

const DATA_DIR = resolve(__dirname, '..', 'public', 'data-h1');

const SECRET_ID = process.env.COS_SECRET_ID;
const SECRET_KEY = process.env.COS_SECRET_KEY;
const BUCKET = process.env.COS_BUCKET;
const REGION = process.env.COS_REGION || 'ap-singapore';
const PATH_PREFIX = (process.env.COS_PATH_PREFIX || '').replace(/^\/+|\/+$/g, '');
const DRY_RUN = process.env.DRY_RUN === '1';
const REBUILD_STATE = process.env.SYNC_REBUILD_STATE === '1';

const ORPHAN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

if (!existsSync(DATA_DIR)) {
    console.error(`❌ ${DATA_DIR} not found. Run bundle-hashed.mjs first.`);
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
        // .manifest-state.json 是本地增量对比用的私有状态，不上传
        if (name.startsWith('.')) continue;
        const full = join(dir, name);
        const stat = statSync(full);
        if (stat.isDirectory()) {
            for (const f of walk(full, base)) out.push(f);
        } else {
            const relative = full.slice(base.length + 1).split(/[\\/]/).join('/');
            out.push({ full, relative, size: stat.size, mtimeMs: Math.floor(stat.mtimeMs) });
        }
    }
    return out;
}

const files = walk(DATA_DIR);

function joinKey(...parts) {
    return parts.filter(Boolean).map(p => p.replace(/^\/+|\/+$/g, '')).join('/');
}

const H1_PREFIX = joinKey(PATH_PREFIX, 'h1');

/** entry/ 走 1 年 immutable（内容寻址）；manifest*／manifest-root 走短缓存（60–300s 区间取 120s）。 */
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const SHORT_CACHE = 'public, max-age=120, must-revalidate';

function cacheControlFor(relative) {
    return relative.startsWith('entry/') ? IMMUTABLE_CACHE : SHORT_CACHE;
}

// 三批的分类：entry / manifest 分片 / manifest-root.json（固定单文件，不算「分片」）
function batchOf(relative) {
    if (relative.startsWith('entry/')) return 'entry';
    if (relative === 'manifest-root.json') return 'root';
    return 'manifest'; // manifest/<shard>.json
}

const entryFiles = files.filter(f => batchOf(f.relative) === 'entry');
const manifestFiles = files.filter(f => batchOf(f.relative) === 'manifest');
const rootFiles = files.filter(f => batchOf(f.relative) === 'root');

console.log(`\nsync-h1-to-cos`);
console.log(`  bucket: ${BUCKET}`);
console.log(`  region: ${REGION}`);
console.log(`  source: ${DATA_DIR}`);
console.log(`  target: cos://${BUCKET}/${H1_PREFIX}/`);
console.log(`  local:  entry ${entryFiles.length} 个（${(entryFiles.reduce((s, f) => s + f.size, 0) / 1024 / 1024).toFixed(1)} MB），manifest 分片 ${manifestFiles.length} 个，root ${rootFiles.length} 个`);
console.log(`  mode:   ${DRY_RUN ? 'DRY RUN（不联网、不需要 COS 凭据）' : 'UPLOAD'}\n`);

// ─── state（上次成功 sync 时各文件的 { md5, lastModified }，key 是相对路径） ───
//
// lastModified 是「这个 key 最后一次被确认在 COS 上存在」的时间：真实上传时记
// upload 完成的时刻；从 COS 拉 ETag 重建时记 COS 返回的真实 LastModified。
// entry 孤儿要不要删，看的正是这个字段有没有过 7 天——不是本地文件的 mtime
// （本地文件早就被 bundle-hashed.mjs 的 GC 删了，走到这里的孤儿本地根本不存在）。

const HASH_CACHE_FILE = resolve(__dirname, '..', '.next', '.sync-h1-hash-cache.json');
// 真实上传成功后落的 state —— 只有它能代表「COS 上实际有什么」。
const SYNC_STATE_FILE = resolve(__dirname, '..', '.next', '.sync-h1-state.json');
// DRY_RUN 专用的另一份 state：dry-run 从不联网，不能也不该假装知道 COS 的真实状态；
// 但要衡量「两次相邻提交增量传多少」（完成判据 3）与孤儿保留期的推进，dry-run
// 之间需要能看见彼此的差异——于是单独开一个文件，只由 dry-run 读写，绝不会被
// 真实上传流程读到，也绝不会让真实上传误以为 dry-run 已经把东西传上去了。
const DRYRUN_STATE_FILE = resolve(__dirname, '..', '.next', '.sync-h1-dryrun-state.json');

// state 格式 v2：files[rel] = { md5, lastModified(ms) }。v1（值是裸 md5 字符串，
// 没有 lastModified）判过期不读，等同没有 state——重建即可，反正本布局还没上线。
function loadStateFile(path) {
    try {
        if (!existsSync(path)) return null;
        const raw = JSON.parse(readFileSync(path, 'utf-8'));
        if (raw?.version !== 2 || !raw?.files) return null;
        return new Map(Object.entries(raw.files));
    } catch (e) {
        console.warn(`  state load failed (${path}: ${e.message}), will rebuild`);
        return null;
    }
}

function saveStateFile(path, stateMap) {
    try {
        mkdirSync(dirname(path), { recursive: true });
        const doc = { version: 2, savedAt: new Date().toISOString(), files: Object.fromEntries(stateMap) };
        writeFileSync(path, JSON.stringify(doc), 'utf-8');
    } catch (e) {
        console.warn(`  state save failed (${path}: ${e.message}), ignored`);
    }
}

const loadSyncState = () => loadStateFile(SYNC_STATE_FILE);
const saveSyncState = (m) => saveStateFile(SYNC_STATE_FILE, m);
const loadDryRunState = () => loadStateFile(DRYRUN_STATE_FILE);
const saveDryRunState = (m) => saveStateFile(DRYRUN_STATE_FILE, m);

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
        writeFileSync(HASH_CACHE_FILE, JSON.stringify(Object.fromEntries(cache)), 'utf-8');
    } catch (e) {
        console.warn(`  hash cache save failed (${e.message}), ignored`);
    }
}

function md5OfFile(path) {
    const hash = createHash('md5');
    hash.update(readFileSync(path));
    return hash.digest('hex');
}

function md5WithCache(file, cache) {
    const entry = cache.get(file.relative);
    if (entry && entry.size === file.size && entry.mtimeMs === file.mtimeMs) {
        return { md5: entry.md5, hit: true };
    }
    const md5 = md5OfFile(file.full);
    cache.set(file.relative, { size: file.size, mtimeMs: file.mtimeMs, md5 });
    return { md5, hit: false };
}

function ext(name) {
    const i = name.lastIndexOf('.');
    return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

function contentTypeFor(relative) {
    return ext(relative) === 'json' ? 'application/json; charset=utf-8' : 'application/octet-stream';
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

/**
 * 纯计算：给定 state（rel → {md5, lastModified}）与本地 md5，
 * 算出三批各自要传什么、孤儿怎么处置。不联网、不改任何文件。
 */
function planBatches(stateMap, localMd5, now = Date.now()) {
    const changed = (rel) => stateMap.get(rel)?.md5 !== localMd5.get(rel);

    const entryUpload = entryFiles.filter(f => changed(f.relative));
    const manifestUpload = manifestFiles.filter(f => changed(f.relative));
    const rootUpload = rootFiles.filter(f => changed(f.relative));
    const skipped = files.length - entryUpload.length - manifestUpload.length - rootUpload.length;

    const localRelSet = new Set(files.map(f => f.relative));
    const entryOrphansToDelete = [];
    const entryOrphansToKeep = [];
    const manifestOrphansToDelete = [];

    for (const [rel, meta] of stateMap.entries()) {
        if (localRelSet.has(rel)) continue; // 不是孤儿
        const kind = batchOf(rel);
        if (kind === 'entry') {
            const age = now - (meta?.lastModified ?? 0);
            if (age >= ORPHAN_RETENTION_MS) entryOrphansToDelete.push(rel);
            else entryOrphansToKeep.push(rel);
        } else if (kind === 'manifest') {
            manifestOrphansToDelete.push(rel);
        }
        // kind === 'root'：manifest-root.json 是固定单文件，本地文件不存在的话
        // walk() 早报过 DATA_DIR 不存在的错，这里不会出现「root 孤儿」这种情况。
    }

    return {
        entryUpload, manifestUpload, rootUpload, skipped,
        entryOrphansToDelete, entryOrphansToKeep, manifestOrphansToDelete,
    };
}

function logPlan(plan) {
    const bytes = (arr) => (arr.reduce((s, f) => s + f.size, 0) / 1024 / 1024).toFixed(2);
    console.log(`\n  计划（三批按序）：`);
    console.log(`    ① entry:          ${plan.entryUpload.length} 个（${bytes(plan.entryUpload)} MB）`);
    console.log(`    ② manifest 分片:  ${plan.manifestUpload.length} 个（${bytes(plan.manifestUpload)} MB）`);
    console.log(`    ③ manifest-root:  ${plan.rootUpload.length} 个`);
    console.log(`    跳过（未变）:      ${plan.skipped} 个`);
    console.log(`    孤儿·entry 保留:   ${plan.entryOrphansToKeep.length} 个（未满 7 天）`);
    console.log(`    孤儿·entry 删除:   ${plan.entryOrphansToDelete.length} 个（已满 7 天）`);
    console.log(`    孤儿·manifest 删除: ${plan.manifestOrphansToDelete.length} 个（分片本身照删）`);
    const totalUpload = plan.entryUpload.length + plan.manifestUpload.length + plan.rootUpload.length;
    const totalUploadBytes = [...plan.entryUpload, ...plan.manifestUpload, ...plan.rootUpload]
        .reduce((s, f) => s + f.size, 0);
    console.log(`    上传总计:          ${totalUpload} 个文件，${(totalUploadBytes / 1024 / 1024).toFixed(2)} MB`);
}

async function planOnly() {
    // DRY_RUN 用独立的 dry-run state（见上方注释）；真实上传用真正的 sync state，
    // 缺失时留给 main() 去问 COS 要真相（含真实 LastModified，用于孤儿判老）。
    let stateMap = REBUILD_STATE ? null : (DRY_RUN ? loadDryRunState() : loadSyncState());
    let stateSource = DRY_RUN ? 'local dry-run state' : 'local sync state';
    if (!stateMap) {
        stateMap = new Map();
        stateSource = DRY_RUN
            ? '空（首次 dry-run 或指定 SYNC_REBUILD_STATE=1，视同首次全量）'
            : '空（真跑时 main() 会从 COS 拉 ETag+LastModified 重建，此处仅先给一个占位计划）';
    }
    console.log(`  state 来源: ${stateSource}（已知 ${stateMap.size} 个 key）`);

    const hashCache = loadHashCache();
    let cacheHits = 0;
    const localMd5 = new Map();
    for (const f of files) {
        const { md5, hit } = md5WithCache(f, hashCache);
        localMd5.set(f.relative, md5);
        if (hit) cacheHits++;
    }
    if (!DRY_RUN) saveHashCache(hashCache);
    console.log(`  本地 md5：${files.length} 个文件（cache 命中 ${cacheHits}/${files.length}）`);

    const plan = planBatches(stateMap, localMd5);
    logPlan(plan);

    return { stateMap, localMd5, plan };
}

async function main() {
    const { localMd5, stateMap: initialState, plan: initialPlan } = await planOnly();

    if (DRY_RUN) {
        // dry-run 的「假装执行」：孤儿超期的从 state 里摘掉，未超期的原样保留
        // （lastModified 不动，让下一次 dry-run 继续用真实经过的时间判老）；
        // 本轮变化的文件 lastModified 记为现在。不联网、不改真实 COS 或真实 state。
        const now = Date.now();
        const newDryState = new Map(initialState);
        for (const f of files) {
            const rel = f.relative;
            const md5 = localMd5.get(rel);
            const prev = newDryState.get(rel);
            newDryState.set(rel, { md5, lastModified: prev?.md5 === md5 ? prev.lastModified : now });
        }
        for (const rel of initialPlan.entryOrphansToDelete) newDryState.delete(rel);
        for (const rel of initialPlan.manifestOrphansToDelete) newDryState.delete(rel);
        saveDryRunState(newDryState);
        console.log('\n(dry run，未联网、未触碰真实 COS 或真实 sync-state；已更新 dry-run 专用 state 供下次对比)\n');
        return;
    }

    let COS;
    try {
        COS = require('cos-nodejs-sdk-v5');
    } catch {
        console.error('❌ cos-nodejs-sdk-v5 not installed. Run: npm i -D cos-nodejs-sdk-v5');
        process.exit(1);
    }
    const cos = new COS({
        SecretId: SECRET_ID,
        SecretKey: SECRET_KEY,
        FileParallelLimit: 80,
        ChunkParallelLimit: 8,
        Timeout: 60 * 1000,
    });

    /** 列一个 prefix 下所有对象的 key/ETag/LastModified —— state 重建用，带真实老化时间。 */
    async function listPrefixMeta(prefix) {
        const map = new Map();
        let marker = '';
        while (true) {
            const res = await new Promise((resolveP, rejectP) => {
                cos.getBucket({ Bucket: BUCKET, Region: REGION, Prefix: prefix, Marker: marker, MaxKeys: 1000 },
                    (err, data) => err ? rejectP(err) : resolveP(data));
            });
            for (const obj of res.Contents || []) {
                const rel = obj.Key.slice(prefix.length);
                const md5 = (obj.ETag || '').replace(/^"|"$/g, '');
                const lastModified = obj.LastModified ? Date.parse(obj.LastModified) : Date.now();
                map.set(rel, { md5, lastModified });
            }
            if (res.IsTruncated === 'true' || res.IsTruncated === true) {
                marker = res.NextMarker || res.Contents[res.Contents.length - 1].Key;
            } else break;
        }
        return map;
    }

    let stateMap = initialState;
    let plan = initialPlan;
    if (stateMap.size === 0 || REBUILD_STATE) {
        console.log(`  ${REBUILD_STATE ? 'SYNC_REBUILD_STATE=1' : 'no local sync-h1-state'}, listing COS to rebuild...`);
        stateMap = await listPrefixMeta(`${H1_PREFIX}/`);
        console.log(`  rebuilt state from cos: ${stateMap.size} keys`);
        plan = planBatches(stateMap, localMd5);
        console.log(`  重新计划：`);
        logPlan(plan);
    }

    async function uploadOne(file, attempt = 1) {
        const key = `${H1_PREFIX}/${file.relative}`;
        try {
            return await new Promise((resolveP, rejectP) => {
                cos.putObject({
                    Bucket: BUCKET, Region: REGION, Key: key,
                    Body: readFileSync(file.full),
                    ContentType: contentTypeFor(file.relative),
                    CacheControl: cacheControlFor(file.relative),
                }, (err) => err ? rejectP(err) : resolveP());
            });
        } catch (e) {
            const transient = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network/i.test(e.message || '');
            if (transient && attempt < 4) {
                await new Promise(r => setTimeout(r, 500 * 2 ** attempt));
                return uploadOne(file, attempt + 1);
            }
            throw e;
        }
    }

    async function deleteOne(rel, attempt = 1) {
        const key = `${H1_PREFIX}/${rel}`;
        try {
            return await new Promise((resolveP, rejectP) => {
                cos.deleteObject({ Bucket: BUCKET, Region: REGION, Key: key }, (err) => err ? rejectP(err) : resolveP());
            });
        } catch (e) {
            const transient = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network/i.test(e.message || '');
            if (transient && attempt < 4) {
                await new Promise(r => setTimeout(r, 500 * 2 ** attempt));
                return deleteOne(rel, attempt + 1);
            }
            throw e;
        }
    }

    /** 跑一批上传；有任何失败就打印原因、退出（state 不落），不进下一批。 */
    async function runUploadBatch(label, items) {
        if (items.length === 0) {
            console.log(`  ${label}: 0 个，跳过`);
            return;
        }
        console.log(`  ${label}: 上传 ${items.length} 个...`);
        const r = await runQueue(items, 80, uploadOne, label);
        if (r.failures.length > 0) {
            console.error(`\n❌ ${label} 有 ${r.failures.length}/${items.length} 个失败，不进下一批，state 不落。重跑整轮即可重试。`);
            process.exit(2);
        }
        console.log(`  ✓ ${label} 完成 ${r.done}/${items.length} in ${r.elapsed.toFixed(1)}s`);
    }

    // ─── 三批按序：entry → manifest 分片 → manifest-root.json ───
    await runUploadBatch('① entry', plan.entryUpload);
    await runUploadBatch('② manifest 分片', plan.manifestUpload);
    await runUploadBatch('③ manifest-root', plan.rootUpload);

    // ─── 删孤儿：manifest 分片孤儿照删；entry 孤儿只删满 7 天的 ───
    const allDeleteFailures = [];
    if (plan.manifestOrphansToDelete.length > 0) {
        console.log(`  删除 manifest 孤儿分片...`);
        const r = await runQueue(plan.manifestOrphansToDelete, 80, (rel) => deleteOne(rel), 'delete-manifest-orphan');
        console.log(`  ✓ 删除 ${r.done}/${plan.manifestOrphansToDelete.length} 个 manifest 孤儿分片`);
        allDeleteFailures.push(...r.failures);
    }
    if (plan.entryOrphansToDelete.length > 0) {
        console.log(`  删除已满 7 天的 entry 孤儿...`);
        const r = await runQueue(plan.entryOrphansToDelete, 80, (rel) => deleteOne(rel), 'delete-entry-orphan');
        console.log(`  ✓ 删除 ${r.done}/${plan.entryOrphansToDelete.length} 个已过期 entry 孤儿`);
        allDeleteFailures.push(...r.failures);
    }
    if (plan.entryOrphansToKeep.length > 0) {
        console.log(`  保留 ${plan.entryOrphansToKeep.length} 个未满 7 天的 entry 孤儿（下次 sync 再判）`);
    }

    if (allDeleteFailures.length > 0) {
        console.error(`\n❌ ${allDeleteFailures.length} 个孤儿删除失败。state 不落，重跑整轮即可重试（删除幂等）。`);
        process.exit(2);
    }

    // ─── 落 state：变化的文件记新 md5+现在时间；未变的保留原 lastModified；
    //     保留期内的孤儿继续留在 state 里（不然下次就判不出它的年龄了）；
    //     被删掉的孤儿从 state 摘除 ───
    const now = Date.now();
    const newState = new Map(stateMap);
    for (const f of files) {
        const rel = f.relative;
        const md5 = localMd5.get(rel);
        const prev = newState.get(rel);
        newState.set(rel, { md5, lastModified: prev?.md5 === md5 ? prev.lastModified : now });
    }
    for (const rel of plan.entryOrphansToDelete) newState.delete(rel);
    for (const rel of plan.manifestOrphansToDelete) newState.delete(rel);

    saveSyncState(newState);
    console.log(`  ✓ sync-h1-state saved (${newState.size} keys)`);
    console.log(`\n✅ sync-h1-to-cos complete\n`);
}

main().catch(err => {
    console.error(`\n❌ Fatal: ${err.message}`);
    process.exit(1);
});
