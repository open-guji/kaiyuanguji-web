#!/usr/bin/env node
/**
 * sync-h1-text-to-cos.mjs — 把 bundle-hashed-text.mjs 产出的 public/data-h1-text/
 * 同步到腾讯云 COS（A3b 第二期：整理本／全文按内容哈希寻址；S3：版本根清单）
 *
 * 与 sync-h1-to-cos.mjs（entry 布局）共用同一套机制（`scripts/lib/h1-sync-core.mjs`：
 * 四批按序上传 + 孤儿状态机 + 在用 root 集合），上传目标是**同一个新加坡桶、
 * 同一个 `h1/` 前缀**，只是更深一层的子路径（`h1/text/…`、`h1/text-manifest/…`、
 * `h1/text-roots/…`），与 `h1/entry/…`、`h1/manifest/…`、`h1/roots/…`、
 * `current/`／`v/` 互不影响、互不覆盖。
 *
 * 布局：
 *   cos://{bucket}/h1/text/<owner_id>/<相对路径插入哈希>       内容寻址，immutable 1 年
 *   cos://{bucket}/h1/text-manifest/<owner后缀2位>.<hash8>.json  owner→{相对路径→hash8}
 *                                                             的分片本身也按内容
 *                                                             哈希命名，immutable
 *   cos://{bucket}/h1/text-roots/<dataCommitKey>.json         本次发布的文本版本
 *                                                             根清单，immutable
 *   cos://{bucket}/h1/text-manifest-root.json                 指针：{version:2,
 *                                                             root, …}，短缓存
 *   cos://{bucket}/h1/_meta/text-orphans.json                 text 孤儿的「成为
 *                                                             孤儿时间」表——单独
 *                                                             一张表，不与 entry
 *                                                             的共用
 *   cos://{bucket}/h1/_meta/text-roots-history.json           text 侧 root commit
 *                                                             历史 ledger，单独
 *                                                             一张，不与 entry 共用
 *
 * 四批按序上传（S3 新增 roots）、孤儿保留 7 天按「成为孤儿的时间」算——两条
 * 规矩与 sync-h1-to-cos.mjs 完全一致，机制在共用库里；text-manifest／
 * text-roots 的孤儿判定同样改成「不被任何在用 root 引用」（runRootsRetention），
 * 不再是「本地没有就删」，理由与 entry 侧一致（详见 sync-h1-to-cos.mjs 文件头，
 * 这里不重复）。这里只提供「哪些文件归哪一批、缓存策略、状态文件放哪」这些配置。
 *
 * 环境变量：与 sync-h1-to-cos.mjs 相同的 COS_SECRET_ID / COS_SECRET_KEY /
 * COS_BUCKET / COS_REGION（默认 ap-singapore）／COS_PATH_PREFIX／DRY_RUN／
 * SYNC_REBUILD_STATE／H1_ROOTS_KEEP（默认 5）／H1_TEXT_STAGING_POINTER_KEY
 * （可选，完整 COS key，指向 text 侧自己的测试站指针——单独一个变量名，
 * 不与 entry 侧的 H1_STAGING_POINTER_KEY 混用：两条 sync 各自的指针文件不同
 * 名，测试站部署时二者很可能配的是不同 key）。
 *
 * 用法：
 *   node scripts/sync-h1-text-to-cos.mjs
 *   DRY_RUN=1 node scripts/sync-h1-text-to-cos.mjs
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
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

const DATA_DIR = resolve(__dirname, '..', 'public', 'data-h1-text');

const SECRET_ID = process.env.COS_SECRET_ID;
const SECRET_KEY = process.env.COS_SECRET_KEY;
const BUCKET = process.env.COS_BUCKET;
const REGION = process.env.COS_REGION || 'ap-singapore';
const PATH_PREFIX = (process.env.COS_PATH_PREFIX || '').replace(/^\/+|\/+$/g, '');
const DRY_RUN = process.env.DRY_RUN === '1';
const REBUILD_STATE = process.env.SYNC_REBUILD_STATE === '1';
const ROOTS_KEEP = Number(process.env.H1_ROOTS_KEEP || 5);
const STAGING_POINTER_KEY = process.env.H1_TEXT_STAGING_POINTER_KEY || null;

if (!existsSync(DATA_DIR)) {
    console.error(`❌ ${DATA_DIR} not found. Run bundle-hashed-text.mjs first.`);
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
const TEXT_ORPHANS_KEY = `${H1_PREFIX}/_meta/text-orphans.json`;
const POINTER_KEY = `${H1_PREFIX}/text-manifest-root.json`;
const ROOTS_LEDGER_KEY = `${H1_PREFIX}/_meta/text-roots-history.json`;

const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const SHORT_CACHE = 'public, max-age=120, must-revalidate';

function cacheControlFor(relative) {
    return relative === 'text-manifest-root.json' ? SHORT_CACHE : IMMUTABLE_CACHE;
}

// 四批：text（保留 7 天再删孤儿）／text-manifest 分片（在用 root 引用才活）
// ／text-roots（本轮版本根清单，同样按在用集合判孤儿）／text-manifest-root（指针，最后翻转）
const BATCHES = [
    { key: 'text', label: '① text', match: (rel) => rel.startsWith('text/'), retain: true },
    { key: 'text-manifest', label: '② text-manifest 分片', match: (rel) => rel.startsWith('text-manifest/'), retain: false, skipOrphans: true },
    { key: 'text-roots', label: '③ text-roots', match: (rel) => rel.startsWith('text-roots/'), retain: false, skipOrphans: true },
    { key: 'pointer', label: '④ text-manifest-root（指针）', match: (rel) => rel === 'text-manifest-root.json', retain: false, skipOrphans: true },
];

const files = walk(DATA_DIR);
const textFiles = files.filter(f => f.relative.startsWith('text/'));
const manifestFiles = files.filter(f => f.relative.startsWith('text-manifest/'));
const rootsBatchFiles = files.filter(f => f.relative.startsWith('text-roots/'));
const pointerFiles = files.filter(f => f.relative === 'text-manifest-root.json');

if (rootsBatchFiles.length !== 1) {
    console.error(`❌ 期望本地恰好 1 个 text-roots/*.json（本轮版本根清单），实际 ${rootsBatchFiles.length} 个。请重跑 bundle-hashed-text.mjs。`);
    process.exit(1);
}
const newRootDoc = JSON.parse(readFileSync(rootsBatchFiles[0].full, 'utf-8'));
const newCommit = rootsBatchFiles[0].relative.slice('text-roots/'.length, -'.json'.length);

console.log(`\nsync-h1-text-to-cos`);
console.log(`  bucket: ${BUCKET}`);
console.log(`  region: ${REGION}`);
console.log(`  source: ${DATA_DIR}`);
console.log(`  target: cos://${BUCKET}/${H1_PREFIX}/`);
console.log(`  local:  text ${textFiles.length} 个（${(textFiles.reduce((s, f) => s + f.size, 0) / 1024 / 1024).toFixed(1)} MB），text-manifest 分片 ${manifestFiles.length} 个，text-roots ${rootsBatchFiles.length} 个（本轮 commit=${newCommit}），pointer ${pointerFiles.length} 个`);
console.log(`  h1-roots-keep: ${ROOTS_KEEP}，staging-pointer-key: ${STAGING_POINTER_KEY ?? '（未配置）'}`);
console.log(`  mode:   ${DRY_RUN ? 'DRY RUN（不联网、不需要 COS 凭据）' : 'UPLOAD'}\n`);

// ─── state 文件路径（与 entry 一套分开，避免同一 CI job 内两条 sync 互相覆盖） ───

const HASH_CACHE_FILE = resolve(__dirname, '..', '.next', '.sync-h1-text-hash-cache.json');
const SYNC_STATE_FILE = resolve(__dirname, '..', '.next', '.sync-h1-text-state.json');
const DRYRUN_STATE_FILE = resolve(__dirname, '..', '.next', '.sync-h1-text-dryrun-state.json');
const DRYRUN_ORPHANS_FILE = resolve(__dirname, '..', '.next', '.sync-h1-text-dryrun-orphans.json');
const DRYRUN_ROOTS_STORE_FILE = resolve(__dirname, '..', '.next', '.sync-h1-text-dryrun-roots-store.json');

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

    const currentLocalTextRelSet = new Set(textFiles.map(f => f.relative));

    if (DRY_RUN) {
        const orphansTable = loadDryRunOrphansTable();
        const orphansBefore = orphansTable.size;
        const orphansResult = planOrphans({
            orphansTable,
            candidateOrphanRels: initialPlan.retainOrphanCandidates,
            currentLocalEntryRelSet: currentLocalTextRelSet,
        });
        logOrphansPlan('孤儿表（dry-run 模拟）', orphansResult, orphansBefore);
        saveDryRunOrphansTableFile(orphansResult.newOrphansTable);

        const rootsBackend = createDryRunRootsBackend(DRYRUN_ROOTS_STORE_FILE);
        const manifestOrRootsBatch = initialPlan.uploadsByBatch.filter(b => b.key === 'text-manifest' || b.key === 'text-roots');
        for (const batch of manifestOrRootsBatch) {
            for (const file of batch.upload) {
                await rootsBackend.writeText(`${H1_PREFIX}/${file.relative}`, readFileSync(file.full, 'utf-8'));
            }
        }
        const retentionStats = await runRootsRetention(rootsBackend, {
            h1Prefix: H1_PREFIX, manifestSubdir: 'text-manifest', rootsSubdir: 'text-roots',
            pointerKey: POINTER_KEY, stagingPointerKey: STAGING_POINTER_KEY,
            ledgerKey: ROOTS_LEDGER_KEY, keepN: ROOTS_KEEP, newCommit, newRootDoc,
            shortCacheControl: SHORT_CACHE,
        });
        logRootsRetentionPlan('在用 root 集合（dry-run 模拟）', retentionStats);
        await rootsBackend.writeText(POINTER_KEY, readFileSync(pointerFiles[0].full, 'utf-8'));

        const newDryState = new Map(files.map(f => [f.relative, localMd5.get(f.relative)]));
        saveDryRunState(newDryState);
        console.log('\n(dry run，未联网、未触碰真实 COS；text/orphans 与 roots 在用集合均已在本地模拟状态里跑过一遍，供下次对比)\n');
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
        console.log(`  ${REBUILD_STATE ? 'SYNC_REBUILD_STATE=1' : 'no local sync-h1-text-state'}, listing COS to rebuild...`);
        stateMap = await cosOps.listPrefixEtags(`${H1_PREFIX}/`);
        console.log(`  rebuilt state from cos: ${stateMap.size} keys`);
        plan = planBatches({ batches: BATCHES }, files, stateMap, localMd5);
        console.log(`  重新计划：`);
        logPlan(plan);
    }

    // ─── ①②③ 按序：text → text-manifest 分片 → text-roots/<commit>.json（指针留到最后翻转） ───
    const uploadBatchByKey = Object.fromEntries(plan.uploadsByBatch.map(b => [b.key, b]));
    for (const key of ['text', 'text-manifest', 'text-roots']) {
        const batch = uploadBatchByKey[key];
        await runUploadBatch(batch.label, batch.upload, (file) =>
            cosOps.uploadOne(file, `${H1_PREFIX}/${file.relative}`, cacheControlFor(file.relative), defaultContentTypeFor(file.relative)));
    }

    // ─── 在用 root 集合：清理不再被任何在用 root 引用的 text-manifest 分片／text-roots 文件 ───
    const retentionStats = await runRootsRetention(createCosRootsBackend(cosOps), {
        h1Prefix: H1_PREFIX, manifestSubdir: 'text-manifest', rootsSubdir: 'text-roots',
        pointerKey: POINTER_KEY, stagingPointerKey: STAGING_POINTER_KEY,
        ledgerKey: ROOTS_LEDGER_KEY, keepN: ROOTS_KEEP, newCommit, newRootDoc,
        shortCacheControl: SHORT_CACHE,
    });
    logRootsRetentionPlan('在用 root 集合（h1/_meta/text-roots-history.json）', retentionStats);

    // ─── ④ 翻转指针：text-manifest-root.json 最后上传 ───
    await runUploadBatch(uploadBatchByKey.pointer.label, uploadBatchByKey.pointer.upload, (file) =>
        cosOps.uploadOne(file, `${H1_PREFIX}/${file.relative}`, cacheControlFor(file.relative), defaultContentTypeFor(file.relative)));

    // ─── ⑤ text 孤儿：读 text-orphans.json → 判老 → 删过期的 → 写回 ───
    const orphansTable = await getOrphansTableFromCos(cosOps, TEXT_ORPHANS_KEY);
    const orphansBefore = orphansTable.size;
    const orphansResult = planOrphans({
        orphansTable,
        candidateOrphanRels: plan.retainOrphanCandidates,
        currentLocalEntryRelSet: currentLocalTextRelSet,
    });
    logOrphansPlan('孤儿表（h1/_meta/text-orphans.json）', orphansResult, orphansBefore);

    if (orphansResult.toDelete.length > 0) {
        console.log(`  删除已满 7 天的 text 孤儿...`);
        const r = await runQueue(orphansResult.toDelete, 80, (rel) => cosOps.deleteOne(`${H1_PREFIX}/${rel}`), 'delete-text-orphan');
        console.log(`  ✓ 删除 ${r.done}/${orphansResult.toDelete.length} 个已过期 text 孤儿`);
        if (r.failures.length > 0) {
            console.error(`\n❌ ${r.failures.length} 个 text 孤儿删除失败。text-orphans.json 与 state 均不落，重跑整轮即可重试。`);
            process.exit(2);
        }
    }
    if (orphansResult.toKeep.length > 0) {
        console.log(`  保留 ${orphansResult.toKeep.length} 个未满 7 天的 text 孤儿（下次 sync 再判）`);
    }

    await putOrphansTableToCos(cosOps, TEXT_ORPHANS_KEY, orphansResult.newOrphansTable, { shortCacheControl: SHORT_CACHE });
    console.log(`  ✓ text-orphans.json 写回（${orphansResult.newOrphansTable.size} 条）`);

    const newState = new Map(files.map(f => [f.relative, localMd5.get(f.relative)]));
    saveSyncState(newState);
    console.log(`  ✓ sync-h1-text-state saved (${newState.size} keys)`);
    console.log(`\n✅ sync-h1-text-to-cos complete\n`);
}

main().catch(err => {
    console.error(`\n❌ Fatal: ${err.message}`);
    process.exit(1);
});
