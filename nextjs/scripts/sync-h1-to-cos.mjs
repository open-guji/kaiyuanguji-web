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
 *   cos://{bucket}/h1/_meta/orphans.json          entry 孤儿的「成为孤儿时间」表，
 *                                                 不对前端暴露任何用途，纯 sync 自用
 *
 * 三批按序上传（2026-09-26 协调者验收第二轮定）：
 *   ① 全部新增/变化的 entry ② 变化的 manifest 分片 ③ manifest-root.json
 * 前一批有任何失败就不进下一批：exit(2)，state 不落，整轮重试。
 *
 * entry 孤儿保留 7 天，按「成为孤儿的时间」算，不是「上传时间」
 * （2026-09-26 协调者验收第三轮改）：
 *   第二轮曾把 lastModified 记成上传时刻，结果「30 天前上传、今天才被替换」的
 *   entry 会被判成 30 天大，当场删掉——这正是保留期要防的情况：数据越老越容易
 *   踩中。改法：单独维护 `h1/_meta/orphans.json`（rel → orphanedSince(ms)），
 *   每轮同步只在这张表上做「新孤儿记现在／被重新引用的挪出去／满 7 天的删」
 *   三件事，状态机在 `scripts/lib/h1-orphans.mjs`（纯函数，见其单测
 *   `scripts/lib/h1-orphans.test.mjs`）。这张表必须放 COS，不能放本地
 *   state——CI 每次都是全新 checkout，本地状态活不过一次运行，「孤儿多老」
 *   这件事没有本地状态可谈。manifest 分片的孤儿没有这个顾虑（分片路径固定、
 *   不含哈希，一旦本地没有就是真的没有任何 id 落在这个分片了）照旧当场删。
 *
 * 增量算法：state-driven MD5 diff（只管「传不传」，不管孤儿年龄——年龄
 * 完全交给 orphans.json）。state 缺失/损坏时从 COS 拉 ETag 重建。
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
import { planOrphans, serializeOrphansTable, parseOrphansTable } from './lib/h1-orphans.mjs';

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
const ORPHANS_KEY = `${H1_PREFIX}/_meta/orphans.json`;

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

// ─── state（rel → md5，只管「传不传」，不管孤儿年龄——年龄交给 orphans.json） ───

const HASH_CACHE_FILE = resolve(__dirname, '..', '.next', '.sync-h1-hash-cache.json');
// 真实上传成功后落的 state —— 只有它能代表「COS 上实际有什么内容」。
const SYNC_STATE_FILE = resolve(__dirname, '..', '.next', '.sync-h1-state.json');
// DRY_RUN 专用的另一份 state：dry-run 从不联网，不能也不该假装知道 COS 的真实状态；
// 但要衡量「两次相邻提交增量传多少」（完成判据 3），dry-run 之间需要能看见彼此的
// 差异——于是单独开一个文件，只由 dry-run 读写。
const DRYRUN_STATE_FILE = resolve(__dirname, '..', '.next', '.sync-h1-dryrun-state.json');
// DRY_RUN 专用的孤儿表：模拟 h1/_meta/orphans.json，同样只由 dry-run 读写，
// 让「孤儿保留 7 天」这套状态机在不联网的情况下也能跨次演示。
const DRYRUN_ORPHANS_FILE = resolve(__dirname, '..', '.next', '.sync-h1-dryrun-orphans.json');

// state 格式 v3：files[rel] = md5（v1/v2 的孤儿年龄字段已挪到 orphans.json，
// 判过期不读旧版本，等同没有 state——重建即可，反正本布局还没上线）。
function loadStateFile(path) {
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

function saveStateFile(path, stateMap) {
    try {
        mkdirSync(dirname(path), { recursive: true });
        const doc = { version: 3, savedAt: new Date().toISOString(), files: Object.fromEntries(stateMap) };
        writeFileSync(path, JSON.stringify(doc), 'utf-8');
    } catch (e) {
        console.warn(`  state save failed (${path}: ${e.message}), ignored`);
    }
}

const loadSyncState = () => loadStateFile(SYNC_STATE_FILE);
const saveSyncState = (m) => saveStateFile(SYNC_STATE_FILE, m);
const loadDryRunState = () => loadStateFile(DRYRUN_STATE_FILE);
const saveDryRunState = (m) => saveStateFile(DRYRUN_STATE_FILE, m);

function loadDryRunOrphansTable() {
    try {
        if (!existsSync(DRYRUN_ORPHANS_FILE)) return new Map();
        return parseOrphansTable(readFileSync(DRYRUN_ORPHANS_FILE, 'utf-8'));
    } catch (e) {
        console.warn(`  dry-run orphans table load failed (${e.message}), starting fresh`);
        return new Map();
    }
}

function saveDryRunOrphansTable(table) {
    try {
        mkdirSync(dirname(DRYRUN_ORPHANS_FILE), { recursive: true });
        writeFileSync(DRYRUN_ORPHANS_FILE, serializeOrphansTable(table), 'utf-8');
    } catch (e) {
        console.warn(`  dry-run orphans table save failed (${e.message}), ignored`);
    }
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
 * 纯计算：给定 state（rel → md5）与本地 md5，算出三批各自要传什么、
 * manifest 孤儿有哪些（照删）、entry 孤儿候选有哪些（交给 planOrphans 判老）。
 * 不联网、不改任何文件。
 */
function planBatches(stateMap, localMd5) {
    const changed = (rel) => stateMap.get(rel) !== localMd5.get(rel);

    const entryUpload = entryFiles.filter(f => changed(f.relative));
    const manifestUpload = manifestFiles.filter(f => changed(f.relative));
    const rootUpload = rootFiles.filter(f => changed(f.relative));
    const skipped = files.length - entryUpload.length - manifestUpload.length - rootUpload.length;

    const localRelSet = new Set(files.map(f => f.relative));
    const entryOrphanCandidates = [];
    const manifestOrphansToDelete = [];

    for (const rel of stateMap.keys()) {
        if (localRelSet.has(rel)) continue; // 不是孤儿
        const kind = batchOf(rel);
        if (kind === 'entry') entryOrphanCandidates.push(rel);
        else if (kind === 'manifest') manifestOrphansToDelete.push(rel);
        // kind === 'root'：固定单文件，不会出现「root 孤儿」。
    }

    return { entryUpload, manifestUpload, rootUpload, skipped, entryOrphanCandidates, manifestOrphansToDelete };
}

function logPlan(plan) {
    const bytes = (arr) => (arr.reduce((s, f) => s + f.size, 0) / 1024 / 1024).toFixed(2);
    console.log(`\n  计划（三批按序）：`);
    console.log(`    ① entry:          ${plan.entryUpload.length} 个（${bytes(plan.entryUpload)} MB）`);
    console.log(`    ② manifest 分片:  ${plan.manifestUpload.length} 个（${bytes(plan.manifestUpload)} MB）`);
    console.log(`    ③ manifest-root:  ${plan.rootUpload.length} 个`);
    console.log(`    跳过（未变）:      ${plan.skipped} 个`);
    console.log(`    entry 孤儿候选:    ${plan.entryOrphanCandidates.length} 个（老不老看 orphans.json，下面单独算）`);
    console.log(`    孤儿·manifest 删除: ${plan.manifestOrphansToDelete.length} 个（分片本身照删）`);
    const totalUpload = plan.entryUpload.length + plan.manifestUpload.length + plan.rootUpload.length;
    const totalUploadBytes = [...plan.entryUpload, ...plan.manifestUpload, ...plan.rootUpload]
        .reduce((s, f) => s + f.size, 0);
    console.log(`    上传总计:          ${totalUpload} 个文件，${(totalUploadBytes / 1024 / 1024).toFixed(2)} MB`);
}

function logOrphansPlan(label, orphansResult, tableSizeBefore) {
    console.log(`\n  ${label}：`);
    console.log(`    读到孤儿表:        ${tableSizeBefore} 条`);
    console.log(`    新增（本轮成孤儿）: ${orphansResult.added} 条`);
    console.log(`    移出（重新被引用）: ${orphansResult.reReferenced} 条`);
    console.log(`    保留（未满 7 天）:  ${orphansResult.toKeep.length} 条`);
    console.log(`    删除（已满 7 天）:  ${orphansResult.toDelete.length} 条`);
    console.log(`    写回后孤儿表:      ${orphansResult.newOrphansTable.size} 条`);
}

async function planOnly() {
    // DRY_RUN 用独立的 dry-run state（见上方注释）；真实上传用真正的 sync state，
    // 缺失时留给 main() 去问 COS 要真相。
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

    const plan = planBatches(stateMap, localMd5);
    logPlan(plan);

    return { stateMap, localMd5, plan };
}

async function main() {
    const { localMd5, stateMap: initialState, plan: initialPlan } = await planOnly();

    const currentLocalEntryRelSet = new Set(entryFiles.map(f => f.relative));

    if (DRY_RUN) {
        // dry-run 的「假装执行」：孤儿表用本地专用文件模拟 h1/_meta/orphans.json，
        // 不联网、不改真实 COS 或真实 state，但能跨次 dry-run 演示三种情况。
        const orphansTable = loadDryRunOrphansTable();
        const orphansBefore = orphansTable.size;
        const orphansResult = planOrphans({
            orphansTable,
            candidateOrphanRels: initialPlan.entryOrphanCandidates,
            currentLocalEntryRelSet,
        });
        logOrphansPlan('孤儿表（dry-run 模拟）', orphansResult, orphansBefore);
        saveDryRunOrphansTable(orphansResult.newOrphansTable);

        const newDryState = new Map(files.map(f => [f.relative, localMd5.get(f.relative)]));
        saveDryRunState(newDryState);
        console.log('\n(dry run，未联网、未触碰真实 COS 或真实 sync-state/orphans.json；已更新 dry-run 专用文件供下次对比)\n');
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

    /** 列一个 prefix 下所有对象的 key/ETag —— state 重建用。 */
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

    /**
     * 读 h1/_meta/orphans.json。这张表**必须**来自 COS——它是「孤儿多老」这件事
     * 唯一的真相来源（CI 每次都是全新 checkout）。对象不存在（首次跑）返回空表；
     * 其它读取失败（网络、权限……）一律中止整轮，不猜、不假装是空表——猜错的
     * 后果是把不该删的 entry 删掉。
     */
    async function getOrphansTable() {
        try {
            const res = await new Promise((resolveP, rejectP) => {
                cos.getObject({ Bucket: BUCKET, Region: REGION, Key: ORPHANS_KEY },
                    (err, data) => err ? rejectP(err) : resolveP(data));
            });
            return parseOrphansTable(res.Body.toString('utf-8'));
        } catch (e) {
            const notFound = e?.statusCode === 404 || /NoSuchKey/i.test(e?.code || e?.message || '');
            if (notFound) return new Map();
            console.error(`\n❌ 读取 ${ORPHANS_KEY} 失败（非「不存在」）：${e.message}。不敢猜孤儿年龄，整轮中止，state 不落。`);
            process.exit(2);
        }
    }

    async function putOrphansTable(table) {
        return new Promise((resolveP, rejectP) => {
            cos.putObject({
                Bucket: BUCKET, Region: REGION, Key: ORPHANS_KEY,
                Body: serializeOrphansTable(table),
                ContentType: 'application/json; charset=utf-8',
                CacheControl: SHORT_CACHE,
            }, (err) => err ? rejectP(err) : resolveP());
        });
    }

    let stateMap = initialState;
    let plan = initialPlan;
    if (stateMap.size === 0 || REBUILD_STATE) {
        console.log(`  ${REBUILD_STATE ? 'SYNC_REBUILD_STATE=1' : 'no local sync-h1-state'}, listing COS to rebuild...`);
        stateMap = await listPrefixEtags(`${H1_PREFIX}/`);
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

    // ─── 删 manifest 孤儿分片：没有 7 天顾虑，三批全部上线后立即可删 ───
    const allDeleteFailures = [];
    if (plan.manifestOrphansToDelete.length > 0) {
        console.log(`  删除 manifest 孤儿分片...`);
        const r = await runQueue(plan.manifestOrphansToDelete, 80, (rel) => deleteOne(rel), 'delete-manifest-orphan');
        console.log(`  ✓ 删除 ${r.done}/${plan.manifestOrphansToDelete.length} 个 manifest 孤儿分片`);
        allDeleteFailures.push(...r.failures);
    }
    if (allDeleteFailures.length > 0) {
        console.error(`\n❌ ${allDeleteFailures.length} 个 manifest 孤儿删除失败。state 不落，重跑整轮即可重试（删除幂等）。`);
        process.exit(2);
    }

    // ─── ④ entry 孤儿：读 orphans.json → 判老 → 删过期的 → 写回 ───
    // 放在三批之后：只有当新 entry／manifest／root 都已经全部上线，才谈得上
    // 「这些孤儿已经没有任何当前分片会指向它们」。
    const orphansTable = await getOrphansTable();
    const orphansBefore = orphansTable.size;
    const orphansResult = planOrphans({
        orphansTable,
        candidateOrphanRels: plan.entryOrphanCandidates,
        currentLocalEntryRelSet,
    });
    logOrphansPlan('孤儿表（h1/_meta/orphans.json）', orphansResult, orphansBefore);

    if (orphansResult.toDelete.length > 0) {
        console.log(`  删除已满 7 天的 entry 孤儿...`);
        const r = await runQueue(orphansResult.toDelete, 80, (rel) => deleteOne(rel), 'delete-entry-orphan');
        console.log(`  ✓ 删除 ${r.done}/${orphansResult.toDelete.length} 个已过期 entry 孤儿`);
        if (r.failures.length > 0) {
            console.error(`\n❌ ${r.failures.length} 个 entry 孤儿删除失败。orphans.json 与 state 均不落，重跑整轮即可重试。`);
            process.exit(2);
        }
    }
    if (orphansResult.toKeep.length > 0) {
        console.log(`  保留 ${orphansResult.toKeep.length} 个未满 7 天的 entry 孤儿（下次 sync 再判）`);
    }

    await putOrphansTable(orphansResult.newOrphansTable);
    console.log(`  ✓ orphans.json 写回（${orphansResult.newOrphansTable.size} 条）`);

    // ─── 落 state：本轮实际内容的 md5（不含孤儿年龄——那件事全交给 orphans.json） ───
    const newState = new Map(files.map(f => [f.relative, localMd5.get(f.relative)]));
    saveSyncState(newState);
    console.log(`  ✓ sync-h1-state saved (${newState.size} keys)`);
    console.log(`\n✅ sync-h1-to-cos complete\n`);
}

main().catch(err => {
    console.error(`\n❌ Fatal: ${err.message}`);
    process.exit(1);
});
