#!/usr/bin/env node
/**
 * sync-h1-to-cos.mjs — 把 bundle-hashed.mjs 产出的 public/data-h1/ 同步到腾讯云 COS
 *
 * 与 sync-to-cos.mjs（现行 current/ 布局）并行、互不影响：上传目标是**同一个新加坡桶**
 * 的新前缀 `h1/`，不改、不清、不读现行 `current/`／`v/` 前缀下的任何对象。
 *
 * 布局：
 *   cos://{bucket}/h1/entry/<id>.<hash8>.json      内容寻址，Cache-Control: immutable 1 年
 *   cos://{bucket}/h1/manifest/<后缀2位>.<hash8>.json  id→hash8 分片，分片本身也按
 *                                                   内容哈希命名，immutable 长缓存
 *   cos://{bucket}/h1/roots/<dataCommitKey>.json    本次发布的版本根清单（列出
 *                                                   本版全部 manifest 分片文件名），
 *                                                   immutable 长缓存
 *   cos://{bucket}/h1/manifest-root.json            指针：{version:2, root, …}，短缓存
 *   cos://{bucket}/h1/_meta/orphans.json            entry 孤儿的「成为孤儿时间」表
 *   cos://{bucket}/h1/_meta/roots-history.json      发布过的 root commit 历史
 *                                                   （ledger），供算「最近 N 个」
 *
 * 四批按序上传（S3 在 A3 三批基础上插入 roots）：
 *   ① 全部新增/变化的 entry ② 变化的 manifest 分片 ③ 本轮 roots/<key>.json
 *   ④ manifest-root.json（指针，最后翻转）
 * 前一批有任何失败就不进下一批：exit(2)，state 不落，整轮重试。
 *
 * entry 孤儿保留 7 天，按「成为孤儿的时间」算（2026-09-26 协调者验收第三轮定，
 * 状态机在 `scripts/lib/h1-orphans.mjs`）——本轮未改，仍是「本地没有 = 候选孤儿，
 * 满 7 天才真删」这一套。
 *
 * manifest 分片／roots 文件的孤儿判定（S3，2026-09-27 新增）：
 *   不再是「本地没有就删」——manifest 分片按内容哈希命名后，一次发布的本地
 *   产物只反映"当前这一个 commit"的分片内容，旧 commit 用到的分片本来就不会
 *   出现在本地，若还按老逻辑判，会把"最近 N 个 root 还在引用"的分片当场
 *   误删。改法：③④ 两批上传完成、指针翻转之前，读当前指针（此时仍是旧值）、
 *   测试站指针（若配置了）与 `h1/_meta/roots-history.json`，算出"在用 root
 *   集合"（当前 + 测试站 + 最近 N 个，N 默认 5、`H1_ROOTS_KEEP` 可配），
 *   把所有在用 root 各自引用的分片文件名取并集，COS 上不在这个并集里的
 *   manifest 分片、以及不在在用 commit 集合里的 roots 文件，直接删（没有
 *   7 天保留期顾虑——只要还在"最近 N 个"里就活着，退出这个集合本身已经是
 *   足够的缓冲）。纯函数在 `scripts/lib/h1-roots.mjs`，编排在
 *   `scripts/lib/h1-sync-core.mjs` 的 `runRootsRetention`。
 *
 * 测试站指针（`H1_STAGING_POINTER_KEY`，可选）：今天还没有测试站部署，环境
 * 变量不设时按"没有测试站指针"处理，不影响现有单站行为；等测试站上线后，
 * 该变量指向测试站自己的指针 key（如 `h1/staging-manifest-root.json`），
 * 同一个 `h1/` 前缀下的内容寻址数据两站天然共用，不必再各占一份。
 *
 * 增量算法：state-driven MD5 diff（只管「传不传」，不管孤儿——孤儿完全交给
 * orphans.json／runRootsRetention）。state 缺失/损坏时从 COS 拉 ETag 重建。
 *
 * A3b（第二期，整理本/全文哈希寻址）把「四批按序上传 + 孤儿状态机」这套机制
 * 抽成了共用库 `scripts/lib/h1-sync-core.mjs`，本脚本与 `sync-h1-text-to-cos.mjs`
 * 共用。
 *
 * 环境变量：COS_SECRET_ID / COS_SECRET_KEY / COS_BUCKET / COS_REGION（默认
 * ap-singapore）／COS_PATH_PREFIX／DRY_RUN／SYNC_REBUILD_STATE／
 * H1_ROOTS_KEEP（默认 5）／H1_STAGING_POINTER_KEY（可选，完整 COS key）。
 *
 * 用法：
 *   node scripts/sync-h1-to-cos.mjs
 *   DRY_RUN=1 node scripts/sync-h1-to-cos.mjs
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { planOrphans, serializeOrphansTable, parseOrphansTable } from './lib/h1-orphans.mjs';
import {
    walk, md5WithCache, loadHashCache, saveHashCache,
    loadStateFile, saveStateFile, defaultContentTypeFor,
    planBatches, logPlan, logOrphansPlan,
    requireCosSdk, createCosOps, runUploadBatch, runQueue,
    getOrphansTableFromCos, putOrphansTableToCos,
    createCosRootsBackend, runRootsRetention, logRootsRetentionPlan,
} from './lib/h1-sync-core.mjs';
import { createDryRunRootsBackend } from './lib/h1-roots-dryrun-backend.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
const ROOTS_KEEP = Number(process.env.H1_ROOTS_KEEP || 5);
const STAGING_POINTER_KEY = process.env.H1_STAGING_POINTER_KEY || null;

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

function joinKey(...parts) {
    return parts.filter(Boolean).map(p => p.replace(/^\/+|\/+$/g, '')).join('/');
}

const H1_PREFIX = joinKey(PATH_PREFIX, 'h1');
const ORPHANS_KEY = `${H1_PREFIX}/_meta/orphans.json`;
const POINTER_KEY = `${H1_PREFIX}/manifest-root.json`;
const ROOTS_LEDGER_KEY = `${H1_PREFIX}/_meta/roots-history.json`;

/** entry/、manifest 分片、roots/ 都是内容寻址，走 1 年 immutable；指针短缓存（60–300s 区间取 120s）。 */
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const SHORT_CACHE = 'public, max-age=120, must-revalidate';

function cacheControlFor(relative) {
    return relative === 'manifest-root.json' ? SHORT_CACHE : IMMUTABLE_CACHE;
}

// 四批：entry（保留 7 天再删孤儿）／manifest 分片（在用 root 引用才活，见 runRootsRetention）
// ／roots（本轮版本根清单，同样按在用集合判孤儿）／manifest-root（指针，最后翻转）
const BATCHES = [
    { key: 'entry', label: '① entry', match: (rel) => rel.startsWith('entry/'), retain: true },
    { key: 'manifest', label: '② manifest 分片', match: (rel) => rel.startsWith('manifest/'), retain: false, skipOrphans: true },
    { key: 'roots', label: '③ roots', match: (rel) => rel.startsWith('roots/'), retain: false, skipOrphans: true },
    { key: 'pointer', label: '④ manifest-root（指针）', match: (rel) => rel === 'manifest-root.json', retain: false, skipOrphans: true },
];

const files = walk(DATA_DIR);
const entryFiles = files.filter(f => f.relative.startsWith('entry/'));
const manifestFiles = files.filter(f => f.relative.startsWith('manifest/'));
const rootsBatchFiles = files.filter(f => f.relative.startsWith('roots/'));
const pointerFiles = files.filter(f => f.relative === 'manifest-root.json');

if (rootsBatchFiles.length !== 1) {
    console.error(`❌ 期望本地恰好 1 个 roots/*.json（本轮版本根清单），实际 ${rootsBatchFiles.length} 个。请重跑 bundle-hashed.mjs。`);
    process.exit(1);
}
const newRootDoc = JSON.parse(readFileSync(rootsBatchFiles[0].full, 'utf-8'));
const newCommit = rootsBatchFiles[0].relative.slice('roots/'.length, -'.json'.length);

console.log(`\nsync-h1-to-cos`);
console.log(`  bucket: ${BUCKET}`);
console.log(`  region: ${REGION}`);
console.log(`  source: ${DATA_DIR}`);
console.log(`  target: cos://${BUCKET}/${H1_PREFIX}/`);
console.log(`  local:  entry ${entryFiles.length} 个（${(entryFiles.reduce((s, f) => s + f.size, 0) / 1024 / 1024).toFixed(1)} MB），manifest 分片 ${manifestFiles.length} 个，roots ${rootsBatchFiles.length} 个（本轮 commit=${newCommit}），pointer ${pointerFiles.length} 个`);
console.log(`  h1-roots-keep: ${ROOTS_KEEP}，staging-pointer-key: ${STAGING_POINTER_KEY ?? '（未配置）'}`);
console.log(`  mode:   ${DRY_RUN ? 'DRY RUN（不联网、不需要 COS 凭据）' : 'UPLOAD'}\n`);

// ─── state 文件路径 ───

const HASH_CACHE_FILE = resolve(__dirname, '..', '.next', '.sync-h1-hash-cache.json');
const SYNC_STATE_FILE = resolve(__dirname, '..', '.next', '.sync-h1-state.json');
const DRYRUN_STATE_FILE = resolve(__dirname, '..', '.next', '.sync-h1-dryrun-state.json');
const DRYRUN_ORPHANS_FILE = resolve(__dirname, '..', '.next', '.sync-h1-dryrun-orphans.json');
const DRYRUN_ROOTS_STORE_FILE = resolve(__dirname, '..', '.next', '.sync-h1-dryrun-roots-store.json');

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

function saveDryRunOrphansTableFile(table) {
    try {
        mkdirSync(dirname(DRYRUN_ORPHANS_FILE), { recursive: true });
        writeFileSync(DRYRUN_ORPHANS_FILE, serializeOrphansTable(table), 'utf-8');
    } catch (e) {
        console.warn(`  dry-run orphans table save failed (${e.message}), ignored`);
    }
}

async function planOnly() {
    let stateMap = REBUILD_STATE ? null : (DRY_RUN ? loadDryRunState() : loadSyncState());
    let stateSource = DRY_RUN ? 'local dry-run state' : 'local sync state';
    if (!stateMap) {
        stateMap = new Map();
        stateSource = DRY_RUN
            ? '空（首次 dry-run 或指定 SYNC_REBUILD_STATE=1，视同首次全量）'
            : '空（真跑时 main() 会从 COS 拉 ETag 重建，此处仅先给一个占位计划）';
    }
    console.log(`  state 来源: ${stateSource}（已知 ${stateMap.size} 个 key）`);

    const hashCache = loadHashCache(HASH_CACHE_FILE);
    let cacheHits = 0;
    const localMd5 = new Map();
    for (const f of files) {
        const { md5, hit } = md5WithCache(f, hashCache);
        localMd5.set(f.relative, md5);
        if (hit) cacheHits++;
    }
    if (!DRY_RUN) saveHashCache(HASH_CACHE_FILE, hashCache);
    console.log(`  本地 md5：${files.length} 个文件（cache 命中 ${cacheHits}/${files.length}）`);

    const config = { batches: BATCHES };
    const plan = planBatches(config, files, stateMap, localMd5);
    logPlan(plan);

    return { stateMap, localMd5, plan };
}

async function main() {
    const { localMd5, stateMap: initialState, plan: initialPlan } = await planOnly();

    const currentLocalEntryRelSet = new Set(entryFiles.map(f => f.relative));

    if (DRY_RUN) {
        const orphansTable = loadDryRunOrphansTable();
        const orphansBefore = orphansTable.size;
        const orphansResult = planOrphans({
            orphansTable,
            candidateOrphanRels: initialPlan.retainOrphanCandidates,
            currentLocalEntryRelSet,
        });
        logOrphansPlan('孤儿表（dry-run 模拟）', orphansResult, orphansBefore);
        saveDryRunOrphansTableFile(orphansResult.newOrphansTable);

        // ─── S3：在本地模拟的「假桶」里也真正跑一遍在用集合计算与清理决策 ───
        // 不是只打印"如果跑了会怎样"：模拟桶跨次 dry-run 持久化在
        // DRYRUN_ROOTS_STORE_FILE，两次相邻提交各跑一次就能看到"两个 root
        // 同时存在""孤儿判定按在用集合走"这些效果，而不是每次从空桶算起。
        const rootsBackend = createDryRunRootsBackend(DRYRUN_ROOTS_STORE_FILE);
        const manifestOrRootsBatch = initialPlan.uploadsByBatch.filter(b => b.key === 'manifest' || b.key === 'roots');
        for (const batch of manifestOrRootsBatch) {
            for (const file of batch.upload) {
                await rootsBackend.writeText(`${H1_PREFIX}/${file.relative}`, readFileSync(file.full, 'utf-8'));
            }
        }
        const retentionStats = await runRootsRetention(rootsBackend, {
            h1Prefix: H1_PREFIX, manifestSubdir: 'manifest', rootsSubdir: 'roots',
            pointerKey: POINTER_KEY, stagingPointerKey: STAGING_POINTER_KEY,
            ledgerKey: ROOTS_LEDGER_KEY, keepN: ROOTS_KEEP, newCommit, newRootDoc,
            shortCacheControl: SHORT_CACHE,
        });
        logRootsRetentionPlan('在用 root 集合（dry-run 模拟）', retentionStats);
        // 指针最后翻转（跟真实路径同一个顺序）
        await rootsBackend.writeText(POINTER_KEY, readFileSync(pointerFiles[0].full, 'utf-8'));

        const newDryState = new Map(files.map(f => [f.relative, localMd5.get(f.relative)]));
        saveDryRunState(newDryState);
        console.log('\n(dry run，未联网、未触碰真实 COS；entry/orphans 与 roots 在用集合均已在本地模拟状态里跑过一遍，供下次对比)\n');
        return;
    }

    const COS = requireCosSdk();
    const cos = new COS({
        SecretId: SECRET_ID,
        SecretKey: SECRET_KEY,
        FileParallelLimit: 80,
        ChunkParallelLimit: 8,
        Timeout: 60 * 1000,
    });
    const cosOps = createCosOps({ cos, bucket: BUCKET, region: REGION });

    let stateMap = initialState;
    let plan = initialPlan;
    if (stateMap.size === 0 || REBUILD_STATE) {
        console.log(`  ${REBUILD_STATE ? 'SYNC_REBUILD_STATE=1' : 'no local sync-h1-state'}, listing COS to rebuild...`);
        stateMap = await cosOps.listPrefixEtags(`${H1_PREFIX}/`);
        console.log(`  rebuilt state from cos: ${stateMap.size} keys`);
        plan = planBatches({ batches: BATCHES }, files, stateMap, localMd5);
        console.log(`  重新计划：`);
        logPlan(plan);
    }

    // ─── ①②③ 按序：entry → manifest 分片 → roots/<commit>.json（指针留到最后翻转） ───
    const uploadBatchByKey = Object.fromEntries(plan.uploadsByBatch.map(b => [b.key, b]));
    for (const key of ['entry', 'manifest', 'roots']) {
        const batch = uploadBatchByKey[key];
        await runUploadBatch(batch.label, batch.upload, (file) =>
            cosOps.uploadOne(file, `${H1_PREFIX}/${file.relative}`, cacheControlFor(file.relative), defaultContentTypeFor(file.relative)));
    }

    // ─── 在用 root 集合：清理不再被任何在用 root 引用的 manifest 分片／roots 文件 ───
    // 必须在指针翻转之前算（见 h1-sync-core.mjs 的 runRootsRetention 头部注释）。
    const retentionStats = await runRootsRetention(createCosRootsBackend(cosOps), {
        h1Prefix: H1_PREFIX, manifestSubdir: 'manifest', rootsSubdir: 'roots',
        pointerKey: POINTER_KEY, stagingPointerKey: STAGING_POINTER_KEY,
        ledgerKey: ROOTS_LEDGER_KEY, keepN: ROOTS_KEEP, newCommit, newRootDoc,
        shortCacheControl: SHORT_CACHE,
    });
    logRootsRetentionPlan('在用 root 集合（h1/_meta/roots-history.json）', retentionStats);

    // ─── ④ 翻转指针：manifest-root.json 最后上传 ───
    await runUploadBatch(uploadBatchByKey.pointer.label, uploadBatchByKey.pointer.upload, (file) =>
        cosOps.uploadOne(file, `${H1_PREFIX}/${file.relative}`, cacheControlFor(file.relative), defaultContentTypeFor(file.relative)));

    // ─── ⑤ entry 孤儿：读 orphans.json → 判老 → 删过期的 → 写回 ───
    const orphansTable = await getOrphansTableFromCos(cosOps, ORPHANS_KEY);
    const orphansBefore = orphansTable.size;
    const orphansResult = planOrphans({
        orphansTable,
        candidateOrphanRels: plan.retainOrphanCandidates,
        currentLocalEntryRelSet,
    });
    logOrphansPlan('孤儿表（h1/_meta/orphans.json）', orphansResult, orphansBefore);

    if (orphansResult.toDelete.length > 0) {
        console.log(`  删除已满 7 天的 entry 孤儿...`);
        const r = await runQueue(orphansResult.toDelete, 80, (rel) => cosOps.deleteOne(`${H1_PREFIX}/${rel}`), 'delete-entry-orphan');
        console.log(`  ✓ 删除 ${r.done}/${orphansResult.toDelete.length} 个已过期 entry 孤儿`);
        if (r.failures.length > 0) {
            console.error(`\n❌ ${r.failures.length} 个 entry 孤儿删除失败。orphans.json 与 state 均不落，重跑整轮即可重试。`);
            process.exit(2);
        }
    }
    if (orphansResult.toKeep.length > 0) {
        console.log(`  保留 ${orphansResult.toKeep.length} 个未满 7 天的 entry 孤儿（下次 sync 再判）`);
    }

    await putOrphansTableToCos(cosOps, ORPHANS_KEY, orphansResult.newOrphansTable, { shortCacheControl: SHORT_CACHE });
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
