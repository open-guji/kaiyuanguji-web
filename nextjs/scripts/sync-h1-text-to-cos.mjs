#!/usr/bin/env node
/**
 * sync-h1-text-to-cos.mjs — 把 bundle-hashed-text.mjs 产出的 public/data-h1-text/
 * 同步到腾讯云 COS（A3b 第二期：整理本／全文按内容哈希寻址）
 *
 * 与 sync-h1-to-cos.mjs（entry 布局）共用同一套机制（`scripts/lib/h1-sync-core.mjs`：
 * 三批按序上传 + 孤儿状态机），上传目标是**同一个新加坡桶、同一个 `h1/` 前缀**，
 * 只是更深一层的子路径（`h1/text/…`、`h1/text-manifest/…`），与 `h1/entry/…`、
 * `current/`／`v/` 互不影响、互不覆盖。
 *
 * 布局：
 *   cos://{bucket}/h1/text/<owner_id>/<相对路径插入哈希>   内容寻址，immutable 1 年
 *   cos://{bucket}/h1/text-manifest/<owner id 后缀2位>.json  owner→{相对路径→hash8}，短缓存
 *   cos://{bucket}/h1/text-manifest-root.json               分片数/owner数/文件数/生成时间/数据commit，短缓存
 *   cos://{bucket}/h1/_meta/text-orphans.json                text 孤儿的「成为孤儿时间」表
 *     ——**单独一张表**，不与 entry 的 `h1/_meta/orphans.json` 共用：两者的 key
 *     命名空间不会撞（一个是 `entry/<id>.<hash>.json`，一个是
 *     `text/<owner>/<relPath 插入哈希>`），但分开维护能让两条 sync 各自独立
 *     推进、互不因为共享同一份状态而串起风险。
 *
 * 三批按序上传、孤儿保留 7 天按「成为孤儿的时间」算——两条规矩与 sync-h1-to-cos.mjs
 * 完全一致，机制本身在共用库里，这里只提供「哪些文件归哪一批、缓存策略、
 * 状态文件放哪」这些配置。
 *
 * 环境变量：与 sync-h1-to-cos.mjs 相同的 COS_SECRET_ID / COS_SECRET_KEY /
 * COS_BUCKET / COS_REGION（默认 ap-singapore）／COS_PATH_PREFIX／DRY_RUN／
 * SYNC_REBUILD_STATE。
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
} from './lib/h1-sync-core.mjs';

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

const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const SHORT_CACHE = 'public, max-age=120, must-revalidate';

function cacheControlFor(relative) {
    return relative.startsWith('text/') ? IMMUTABLE_CACHE : SHORT_CACHE;
}

// 三批：text（保留 7 天再删孤儿）／text-manifest 分片（孤儿当场删）／text-manifest-root（固定单文件）
const BATCHES = [
    { key: 'text', label: '① text', match: (rel) => rel.startsWith('text/'), retain: true },
    { key: 'text-manifest', label: '② text-manifest 分片', match: (rel) => rel.startsWith('text-manifest/'), retain: false },
    { key: 'text-manifest-root', label: '③ text-manifest-root', match: (rel) => rel === 'text-manifest-root.json', retain: false },
];

const files = walk(DATA_DIR);
const textFiles = files.filter(f => f.relative.startsWith('text/'));
const manifestFiles = files.filter(f => f.relative.startsWith('text-manifest/'));
const rootFiles = files.filter(f => f.relative === 'text-manifest-root.json');

console.log(`\nsync-h1-text-to-cos`);
console.log(`  bucket: ${BUCKET}`);
console.log(`  region: ${REGION}`);
console.log(`  source: ${DATA_DIR}`);
console.log(`  target: cos://${BUCKET}/${H1_PREFIX}/`);
console.log(`  local:  text ${textFiles.length} 个（${(textFiles.reduce((s, f) => s + f.size, 0) / 1024 / 1024).toFixed(1)} MB），text-manifest 分片 ${manifestFiles.length} 个，root ${rootFiles.length} 个`);
console.log(`  mode:   ${DRY_RUN ? 'DRY RUN（不联网、不需要 COS 凭据）' : 'UPLOAD'}\n`);

// ─── state 文件路径（与 entry 一套分开，避免同一 CI job 内两条 sync 互相覆盖） ───

const HASH_CACHE_FILE = resolve(__dirname, '..', '.next', '.sync-h1-text-hash-cache.json');
const SYNC_STATE_FILE = resolve(__dirname, '..', '.next', '.sync-h1-text-state.json');
const DRYRUN_STATE_FILE = resolve(__dirname, '..', '.next', '.sync-h1-text-dryrun-state.json');
const DRYRUN_ORPHANS_FILE = resolve(__dirname, '..', '.next', '.sync-h1-text-dryrun-orphans.json');

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

        const newDryState = new Map(files.map(f => [f.relative, localMd5.get(f.relative)]));
        saveDryRunState(newDryState);
        console.log('\n(dry run，未联网、未触碰真实 COS 或真实 sync-state/text-orphans.json；已更新 dry-run 专用文件供下次对比)\n');
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

    // ─── 三批按序：text → text-manifest 分片 → text-manifest-root.json ───
    for (const batch of plan.uploadsByBatch) {
        await runUploadBatch(batch.label, batch.upload, (file) =>
            cosOps.uploadOne(file, `${H1_PREFIX}/${file.relative}`, cacheControlFor(file.relative), defaultContentTypeFor(file.relative)));
    }

    // ─── 删 text-manifest 孤儿分片：没有 7 天顾虑，三批全部上线后立即可删 ───
    const allDeleteFailures = [];
    if (plan.immediateOrphansToDelete.length > 0) {
        console.log(`  删除 text-manifest 孤儿分片...`);
        const r = await runQueue(plan.immediateOrphansToDelete, 80, (rel) => cosOps.deleteOne(`${H1_PREFIX}/${rel}`), 'delete-text-manifest-orphan');
        console.log(`  ✓ 删除 ${r.done}/${plan.immediateOrphansToDelete.length} 个 text-manifest 孤儿分片`);
        allDeleteFailures.push(...r.failures);
    }
    if (allDeleteFailures.length > 0) {
        console.error(`\n❌ ${allDeleteFailures.length} 个 text-manifest 孤儿删除失败。state 不落，重跑整轮即可重试（删除幂等）。`);
        process.exit(2);
    }

    // ─── ④ text 孤儿：读 text-orphans.json → 判老 → 删过期的 → 写回 ───
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
