#!/usr/bin/env node
/**
 * bundle-hashed-text.mjs — A3b 第二期：整理本／全文按内容哈希寻址打包（h1 布局）
 *
 * 背景：A3 第一期（bundle-hashed.mjs）只做了条目（entry）。整理本
 * （collated_edition）与全文（full_text）留到本期——同一个痛点（改一卷/一章
 * 就换全局版本号，CDN 靠 `?v=<commit>` 做 cache-bust，全站视同一起失效）在这两类
 * 资产上更严重：单个文件可以到 MB 级，改一卷不该带上全书重新分发。
 *
 * 直接读 bundle-data.mjs 已产出的 public/data/items/<owner_id>/{collated_edition,
 * full_text}/**（不重新生成，保证与现行路径逐字节一致——这是完成判据「20 份文本
 * 逐字节比对」能过的前提）。因此本脚本必须在 bundle-data.mjs **之后**运行。
 *
 * 只扫两个子树，其余 items/<owner_id>/ 下的目录（fragments/sources/
 * volume_book_mapping.json/lineage_graph.json 等）不在本期范围内，原样留在
 * 现行 items/ 路径下，不受影响。
 *
 * 产出（写到 public/data-h1-text/，与 public/data-h1/ 并列，互不覆盖）：
 *   - text/<owner_id>/<相对路径插入哈希>          如
 *     text/d59f2mp12329/collated_edition/index.<hash8>.json、
 *     text/d59f2mp12329/collated_edition/juan/001.<hash8>.json、
 *     text/96kzkdm8e8/full_text/038.<hash8>.md
 *     （相对路径 = collated_edition/… 或 full_text/…，相对 owner 目录，与现行
 *     items/<owner_id>/… 下的路径逐段对应，只在最后一段的文件名里插入哈希，
 *     不改目录层级——前端按 owner+relPath 反查 hash 后能照抄现行路径拼 URL）
 *   - text-manifest/<owner id 后缀 2 位>.json      owner_id → { 相对路径 → hash8 }
 *     （按 owner id **后缀**分片，与 entry 的 manifest 同一套理由：这批
 *     snowflake id 前几位同批几乎恒定，前缀分片会把条目堆进一片，见 29 卡 §2.3）
 *   - text-manifest-root.json                       { shardKeyLength, shardSpace,
 *     shardCount, ownerCount, fileCount, generatedAt, dataCommit }
 *     （单独一份，不复用 entry 的 manifest-root.json——两者是不同的哈希空间：
 *     entry 的 key 是「条目 id」，这里的 key 是「owner_id + 相对路径」二元组，
 *     shardCount／ownerCount／fileCount 对不上号，硬塞进同一份文件会让人误读
 *     两套统计，二选一里选了「另起」）
 *   - .text-manifest-state.json                     上一轮 `${owner}/${relPath}`
 *     → hash8（本脚本自用，供增量对比／垃圾回收，不上传 COS）
 *
 * public/data-h1-text/ **跨次运行保留**（不像 bundle-data.mjs 那样每次清空
 * OUT_DIR）：未变的文件不需要重写，sync 端也不需要重传；只有本轮新增/变化的
 * key 才会有新文件，旧哈希文件会被当场清理（垃圾回收）。首次运行或
 * H1_TEXT_CLEAN=1 时按全量对待。
 *
 * 用法：
 *   node scripts/bundle-hashed-text.mjs
 *   H1_TEXT_OUT_DIR=/path node scripts/bundle-hashed-text.mjs   # 默认 public/data-h1-text
 *   H1_TEXT_CLEAN=1 node scripts/bundle-hashed-text.mjs         # 忽略旧状态，视全部为新增
 */

import { existsSync, readdirSync, statSync, unlinkSync, writeFileSync, readFileSync } from 'fs';
import { join, resolve, dirname, extname, basename } from 'path';
import { fileURLToPath } from 'url';
import { ensureDir, readJson, hash8, writeIfChanged, walk } from './lib/h1-hash-common.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DATA_DIR = resolve(__dirname, '..', 'public', 'data');
const ITEMS_SRC_DIR = join(DATA_DIR, 'items');
const VERSION_FILE = join(DATA_DIR, 'version.json');
const OUT_DIR = resolve(process.env.H1_TEXT_OUT_DIR || join(__dirname, '..', 'public', 'data-h1-text'));
const CLEAN = process.env.H1_TEXT_CLEAN === '1';

// 只扫这两个子树——「整理本」与「全文」，任务书 A3b §一·1 点名的范围。
const SCAN_SUBDIRS = ['collated_edition', 'full_text'];

// 分片键长度：owner_id 末 2 位，与 entry 同一套理由（见文件头注释）。
const SHARD_KEY_LEN = 2;
const SHARD_SPACE = 36 ** SHARD_KEY_LEN;

const TEXT_DIR = join(OUT_DIR, 'text');
const MANIFEST_DIR = join(OUT_DIR, 'text-manifest');
const MANIFEST_ROOT_FILE = join(OUT_DIR, 'text-manifest-root.json');
const STATE_FILE = join(OUT_DIR, '.text-manifest-state.json');

function shardKeyFor(ownerId) { return ownerId.slice(-SHARD_KEY_LEN); }

/** relPath 最后一段插入哈希：'collated_edition/juan/001.json' → '.../001.<hash8>.json'。 */
function insertHash(relPath, hash) {
    const dir = dirname(relPath);
    const base = basename(relPath);
    const ext = extname(base); // 含点，如 '.json'；无扩展名时是 ''
    const stem = ext ? base.slice(0, -ext.length) : base;
    const hashedBase = ext ? `${stem}.${hash}${ext}` : `${stem}.${hash}`;
    return dir === '.' ? hashedBase : `${dir}/${hashedBase}`;
}

function loadState() {
    if (CLEAN || !existsSync(STATE_FILE)) return {};
    try {
        return readJson(STATE_FILE);
    } catch (e) {
        console.warn(`  ⚠ 旧状态读取失败（${e.message}），按全量重建对待`);
        return {};
    }
}

// ─── 1. 扫源：每个 owner 目录下 collated_edition/、full_text/ 两个子树 ───

function scanOwnerFiles() {
    if (!existsSync(ITEMS_SRC_DIR)) {
        console.error(`❌ ${ITEMS_SRC_DIR} 不存在，请先跑 bundle-data.mjs`);
        process.exit(1);
    }

    const files = []; // { ownerId, relPath, full }
    for (const ownerId of readdirSync(ITEMS_SRC_DIR)) {
        const ownerDir = join(ITEMS_SRC_DIR, ownerId);
        if (!statSync(ownerDir).isDirectory()) continue;
        for (const sub of SCAN_SUBDIRS) {
            const subDir = join(ownerDir, sub);
            if (!existsSync(subDir) || !statSync(subDir).isDirectory()) continue;
            for (const f of walk(subDir, ownerDir)) {
                files.push({ ownerId, relPath: f.relative, full: f.full });
            }
        }
    }
    return files;
}

// ─── 2. 算哈希、写 text/<owner_id>/<相对路径插入哈希> ───

function bundleTextFiles(files) {
    const oldState = loadState();
    const newState = {};

    let scanned = 0;
    let newFilesWritten = 0;
    let bytesWritten = 0;
    const ownerSet = new Set();

    for (const { ownerId, relPath, full } of files) {
        const buf = readFileSync(full);
        const h = hash8(buf);
        const key = `${ownerId}/${relPath}`;
        newState[key] = h;
        ownerSet.add(ownerId);
        scanned++;

        if (oldState[key] !== h) {
            const dest = join(TEXT_DIR, ownerId, insertHash(relPath, h));
            if (!existsSync(dest)) {
                ensureDir(dirname(dest));
                writeFileSync(dest, buf);
                newFilesWritten++;
                bytesWritten += buf.length;
            }
        }
    }

    return { oldState, newState, scanned, newFilesWritten, bytesWritten, ownerCount: ownerSet.size };
}

// ─── 3. 垃圾回收：旧哈希不再对应现状的文件删掉 ───

function gcStaleTextFiles(oldState, newState) {
    let removed = 0;
    for (const [key, oldHash] of Object.entries(oldState)) {
        const newHash = newState[key];
        if (newHash === oldHash) continue; // 未变，保留
        const [ownerId, ...relParts] = key.split('/');
        const relPath = relParts.join('/');
        const stalePath = join(TEXT_DIR, ownerId, insertHash(relPath, oldHash));
        if (existsSync(stalePath)) {
            unlinkSync(stalePath);
            removed++;
        }
    }
    return removed;
}

// ─── 4. manifest 分片：owner_id → { 相对路径 → hash8 }，按 owner_id 后缀分片 ───

function bundleManifest(newState) {
    ensureDir(MANIFEST_DIR);

    // key 是 `${ownerId}/${relPath}`；重新按 owner 归组，再按 owner 后缀分片。
    const byOwner = {};
    for (const [key, h] of Object.entries(newState)) {
        const slash = key.indexOf('/');
        const ownerId = key.slice(0, slash);
        const relPath = key.slice(slash + 1);
        (byOwner[ownerId] ??= {})[relPath] = h;
    }

    const shards = {};
    for (const [ownerId, relMap] of Object.entries(byOwner)) {
        const k = shardKeyFor(ownerId);
        (shards[k] ??= {})[ownerId] = relMap;
    }

    let changedShards = 0;
    let totalBytes = 0;
    for (const [k, obj] of Object.entries(shards)) {
        const json = Buffer.from(JSON.stringify(obj));
        totalBytes += json.length;
        if (writeIfChanged(join(MANIFEST_DIR, `${k}.json`), json)) changedShards++;
    }

    let removedShards = 0;
    if (existsSync(MANIFEST_DIR)) {
        for (const fname of readdirSync(MANIFEST_DIR)) {
            const k = fname.slice(0, -'.json'.length);
            if (!(k in shards)) {
                unlinkSync(join(MANIFEST_DIR, fname));
                removedShards++;
            }
        }
    }

    return { shardCount: Object.keys(shards).length, changedShards, removedShards, totalBytes };
}

// ─── 5. text-manifest-root.json ───

function bundleManifestRoot(shardStat, scanStat) {
    let dataCommit = { commitId: 'unknown', productionCommitId: 'unknown', textCommitId: 'unknown' };
    if (existsSync(VERSION_FILE)) {
        const v = readJson(VERSION_FILE);
        dataCommit = {
            commitId: v.commitId,
            productionCommitId: v.productionCommitId,
            textCommitId: v.textCommitId,
        };
    } else {
        console.warn(`  ⚠ ${VERSION_FILE} 不存在，dataCommit 留 unknown`);
    }

    const root = {
        shardKeyLength: SHARD_KEY_LEN,
        shardSpace: SHARD_SPACE,
        shardCount: shardStat.shardCount,
        ownerCount: scanStat.ownerCount,
        fileCount: scanStat.scanned,
        generatedAt: new Date().toISOString(),
        dataCommit,
    };
    writeFileSync(MANIFEST_ROOT_FILE, JSON.stringify(root));
    return root;
}

// ─── main ───

function main() {
    console.log(`\nbundle-hashed-text（h1 布局，整理本／全文）`);
    console.log(`  source: ${ITEMS_SRC_DIR}（只扫 ${SCAN_SUBDIRS.join('、')} 两个子树）`);
    console.log(`  out:    ${OUT_DIR}${CLEAN ? '  (H1_TEXT_CLEAN=1，按全量重建对待)' : ''}\n`);

    const files = scanOwnerFiles();
    const { oldState, newState, scanned, newFilesWritten, bytesWritten, ownerCount } = bundleTextFiles(files);

    if (scanned === 0) {
        console.error('❌ 扫到 0 份文本，检查 public/data/items 下是否有 collated_edition/full_text 子目录（是否已跑 bundle-data.mjs）');
        process.exit(1);
    }

    const removedFiles = gcStaleTextFiles(oldState, newState);
    const shardStat = bundleManifest(newState);
    const root = bundleManifestRoot(shardStat, { scanned, ownerCount });

    writeFileSync(STATE_FILE, JSON.stringify(newState));

    console.log(`TEXT 扫描 ${scanned} 份（${ownerCount} 个 owner），新写 ${newFilesWritten} 个文件（${(bytesWritten / 1024 / 1024).toFixed(2)} MB），回收旧哈希文件 ${removedFiles} 个`);
    console.log(`MANIFEST ${shardStat.shardCount} 片（理论空间 ${SHARD_SPACE}），本轮改动 ${shardStat.changedShards} 片，回收 ${shardStat.removedShards} 片，合计 ${(shardStat.totalBytes / 1024).toFixed(1)} KB`);
    console.log(`ROOT  text-manifest-root.json → shardCount=${root.shardCount} ownerCount=${root.ownerCount} fileCount=${root.fileCount} dataCommit=${root.dataCommit.commitId?.slice(0, 8)}/${root.dataCommit.productionCommitId?.slice(0, 8)}/${root.dataCommit.textCommitId?.slice(0, 8)}`);
    console.log(`\n✅ bundle-hashed-text complete → ${OUT_DIR}\n`);
}

main();
