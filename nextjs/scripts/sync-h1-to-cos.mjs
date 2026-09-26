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
 * 增量算法：与 sync-to-cos.mjs 同一套 state-driven MD5 diff（state 缺失/损坏时从
 * COS 拉 ETag 重建），**不是**因为要另造一套算法，而是它对本布局天然适用：
 * entry/ 的相对路径已经把内容哈希编进文件名，内容一变路径就变，旧路径经
 * bundle-hashed.mjs 的垃圾回收从本地消失，在 diff 里自动落入「orphan」分支被删。
 * manifest*／manifest-root 是可变内容、固定路径，走普通 md5 diff。
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

const entryFiles = files.filter(f => f.relative.startsWith('entry/'));
const manifestFiles = files.filter(f => !f.relative.startsWith('entry/'));

console.log(`\nsync-h1-to-cos`);
console.log(`  bucket: ${BUCKET}`);
console.log(`  region: ${REGION}`);
console.log(`  source: ${DATA_DIR}`);
console.log(`  target: cos://${BUCKET}/${H1_PREFIX}/`);
console.log(`  local:  entry ${entryFiles.length} 个（${(entryFiles.reduce((s, f) => s + f.size, 0) / 1024 / 1024).toFixed(1)} MB），manifest* ${manifestFiles.length} 个（${(manifestFiles.reduce((s, f) => s + f.size, 0) / 1024).toFixed(1)} KB）`);
console.log(`  mode:   ${DRY_RUN ? 'DRY RUN（不联网、不需要 COS 凭据）' : 'UPLOAD'}\n`);

// ─── state（上次成功 sync 时各文件的 md5，key 是相对路径） ───
// 相对路径本身对 entry/ 就编码了内容哈希：内容一变，路径跟着变，旧路径经
// bundle-hashed.mjs 的垃圾回收从本地消失 → 下面的 orphan 分支会把它从 COS 删掉。

const HASH_CACHE_FILE = resolve(__dirname, '..', '.next', '.sync-h1-hash-cache.json');
// 真实上传成功后落的 state —— 只有它能代表「COS 上实际有什么」。
const SYNC_STATE_FILE = resolve(__dirname, '..', '.next', '.sync-h1-state.json');
// DRY_RUN 专用的另一份 state：dry-run 从不联网，不能也不该假装知道 COS 的真实状态；
// 但要衡量「两次相邻提交增量传多少」（完成判据 3），dry-run 之间需要能看见彼此的
// 差异——于是单独开一个文件，只由 dry-run 读写，绝不会被真实上传流程读到，
// 也绝不会让真实上传误以为 dry-run 已经把东西传上去了。
const DRYRUN_STATE_FILE = resolve(__dirname, '..', '.next', '.sync-h1-dryrun-state.json');

function loadStateFile(path, expectedVersion) {
    try {
        if (!existsSync(path)) return null;
        const raw = JSON.parse(readFileSync(path, 'utf-8'));
        if (raw?.version !== expectedVersion || !raw?.files) return null;
        return new Map(Object.entries(raw.files));
    } catch (e) {
        console.warn(`  state load failed (${path}: ${e.message}), will rebuild`);
        return null;
    }
}

function saveStateFile(path, version, stateMap) {
    try {
        mkdirSync(dirname(path), { recursive: true });
        const doc = { version, savedAt: new Date().toISOString(), files: Object.fromEntries(stateMap) };
        writeFileSync(path, JSON.stringify(doc), 'utf-8');
    } catch (e) {
        console.warn(`  state save failed (${path}: ${e.message}), ignored`);
    }
}

const loadSyncState = () => loadStateFile(SYNC_STATE_FILE, 1);
const saveSyncState = (m) => saveStateFile(SYNC_STATE_FILE, 1, m);
const loadDryRunState = () => loadStateFile(DRYRUN_STATE_FILE, 1);
const saveDryRunState = (m) => saveStateFile(DRYRUN_STATE_FILE, 1, m);

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

async function planOnly() {
    // ── 计算本地 MD5，跟 state 比出增量计划 ──
    // DRY_RUN 用独立的 dry-run state（见上方注释）：不联网也能看出「相对上一次
    // dry-run 增量传了多少」，这正是完成判据 3（两次相邻提交对比）要的数字；
    // 真实上传用真正的 sync state，缺失时留给 main() 去问 COS 要真相。
    let stateMap = REBUILD_STATE ? null : (DRY_RUN ? loadDryRunState() : loadSyncState());
    let stateSource = DRY_RUN ? 'local dry-run state' : 'local sync state';
    if (!stateMap) {
        stateMap = new Map();
        stateSource = DRY_RUN
            ? '空（首次 dry-run 或指定 SYNC_REBUILD_STATE=1，视同首次全量）'
            : '空（真跑时 main() 会从 COS 拉 ETag 重建，此处仅先给一个占位计划）';
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

    const toUpload = [];
    let skipped = 0;
    for (const f of files) {
        if (stateMap.get(f.relative) === localMd5.get(f.relative)) {
            skipped++;
        } else {
            toUpload.push(f);
        }
    }
    const localRelSet = new Set(files.map(f => f.relative));
    const orphanKeys = [...stateMap.keys()].filter(rel => !localRelSet.has(rel));

    const uploadEntry = toUpload.filter(f => f.relative.startsWith('entry/'));
    const uploadManifest = toUpload.filter(f => !f.relative.startsWith('entry/'));
    const uploadBytes = toUpload.reduce((s, f) => s + f.size, 0);

    console.log(`\n  计划：`);
    console.log(`    上传 entry:    ${uploadEntry.length} 个（${(uploadEntry.reduce((s, f) => s + f.size, 0) / 1024 / 1024).toFixed(2)} MB）`);
    console.log(`    上传 manifest: ${uploadManifest.length} 个（${(uploadManifest.reduce((s, f) => s + f.size, 0) / 1024).toFixed(1)} KB）`);
    console.log(`    跳过（未变）:   ${skipped} 个`);
    console.log(`    删除 orphan:   ${orphanKeys.length} 个`);
    console.log(`    上传总计:      ${toUpload.length} 个文件，${(uploadBytes / 1024 / 1024).toFixed(2)} MB`);

    return { stateMap, localMd5, toUpload, orphanKeys };
}

async function main() {
    const { toUpload, orphanKeys, localMd5, stateMap: initialState } = await planOnly();

    if (DRY_RUN) {
        // 落 dry-run 专用 state（不碰真实 SYNC_STATE_FILE），让下一次 dry-run
        // 能看见相对这一次的增量——用于两次相邻数据提交的对比测量。
        const newDryState = new Map(files.map(f => [f.relative, localMd5.get(f.relative)]));
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

    async function listPrefixEtags(prefix) {
        const map = new Map();
        let marker = '';
        const stripQuotes = (s) => (s || '').replace(/^"|"$/g, '');
        while (true) {
            const res = await new Promise((resolveP, rejectP) => {
                cos.getBucket({ Bucket: BUCKET, Region: REGION, Prefix: prefix, Marker: marker, MaxKeys: 1000 },
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

    let stateMap = initialState;
    if (stateMap.size === 0 && !REBUILD_STATE) {
        console.log(`  no local sync-h1-state, listing COS to rebuild...`);
    }
    if (stateMap.size === 0 || REBUILD_STATE) {
        stateMap = await listPrefixEtags(`${H1_PREFIX}/`);
        console.log(`  rebuilt state from cos: ${stateMap.size} keys`);
        // 用重建后的 state 重新计划一次（首次跑/state 丢失时，DRY_RUN 阶段的计划可能不准）
        const toUploadReal = [];
        for (const f of files) {
            if (stateMap.get(f.relative) !== localMd5.get(f.relative)) toUploadReal.push(f);
        }
        toUpload.length = 0;
        toUpload.push(...toUploadReal);
        const localRelSet = new Set(files.map(f => f.relative));
        orphanKeys.length = 0;
        orphanKeys.push(...[...stateMap.keys()].filter(rel => !localRelSet.has(rel)));
        console.log(`  重新计划：上传 ${toUpload.length}，删除 ${orphanKeys.length}`);
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

    const allFailures = [];

    if (toUpload.length > 0) {
        console.log(`  uploading...`);
        const r = await runQueue(toUpload, 80, uploadOne, 'upload');
        console.log(`  ✓ uploaded ${r.done}/${toUpload.length} in ${r.elapsed.toFixed(1)}s`);
        allFailures.push(...r.failures);
    }

    if (orphanKeys.length > 0) {
        console.log(`  deleting orphans...`);
        const r = await runQueue(orphanKeys, 80, (rel) => deleteOne(rel), 'delete');
        console.log(`  ✓ deleted ${r.done}/${orphanKeys.length} in ${r.elapsed.toFixed(1)}s`);
        allFailures.push(...r.failures);
    }

    if (allFailures.length > 0) {
        console.error(`\n❌ ${allFailures.length} op(s) failed. NOT updating state. Re-run to retry.`);
        process.exit(2);
    }

    const newState = new Map(files.map(f => [f.relative, localMd5.get(f.relative)]));
    saveSyncState(newState);
    console.log(`  ✓ sync-h1-state saved (${newState.size} keys)`);
    console.log(`\n✅ sync-h1-to-cos complete\n`);
}

main().catch(err => {
    console.error(`\n❌ Fatal: ${err.message}`);
    process.exit(1);
});
