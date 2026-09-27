#!/usr/bin/env node
/**
 * bundle-hashed.mjs — A3 第一期：条目按内容哈希寻址打包（h1 布局，与现行输出并行产出）
 *
 * 背景（[29 卡](../../../overview/项目进展/古籍索引网站/进度/G-工具分发与网站/29-架构原型实测.md)
 * 已实测证实收益）：现行 entry/{id}.json 靠 `?v=<commit>` 做 CDN cache-bust，
 * 改一条目 = 全站缓存一起失效。本脚本产出按内容哈希寻址的平行布局，
 * 只有内容真变了的条目文件名才变，配合 sync-h1-to-cos.mjs 做到「只传改了的」。
 *
 * 直接读 bundle-data.mjs 已产出的 public/data/entry/*.json（不重新合并索引、
 * 不重新注入 has_collated / _path 等字段），保证与现行路径**逐字节一致**——
 * 这是完成判据里「20 条内容对比」能过的前提：两条路径读的是同一份字节。
 * 因此本脚本必须在 bundle-data.mjs **之后**运行。
 *
 * 产出（写到 public/data-h1/，与 public/data/ 并列，互不覆盖）：
 *   - entry/<id>.<hash8>.json         内容 sha256 前 8 位；内容不变则文件不重写
 *   - manifest/<后缀 2 位>.<hash8>.json  id → hash8 的分片本身也按内容哈希命名
 *                                     （S3，见下方"版本根清单"），按 id **后缀**
 *                                     分片（前缀分片在这批 snowflake id 下不均匀，
 *                                     同批同类型 id 前几位几乎恒定，见 29 卡
 *                                     §2.3），id 是 0-9a-z 的 base36 字符，
 *                                     后缀 2 位 = 36×36 = 1296 个可能分片
 *   - roots/<dataCommitKey>.json      本次发布的版本根清单：{ shardKeyLength,
 *                                     shardSpace, shardCount, generatedAt,
 *                                     dataCommit, shards: {后缀→hash8} }，
 *                                     不可变（同一 dataCommitKey 下内容恒定）
 *   - promotions/<后缀 2 位>.<hash8>.json  升格对照表分片（PH）：{ 草稿id: 正式id }，
 *                                     与 manifest 同一套后缀分片、同样按内容哈希命名，
 *                                     列在 roots 文档的 promotionShards 里（见
 *                                     lib/h1-promotions.mjs）
 *   - manifest-root.json              降级成一个指针：{ version: 2, root:
 *                                     "<dataCommitKey>.json", generatedAt,
 *                                     dataCommit }，短缓存
 *   - .manifest-state.json            上一轮 id→hash8（本脚本自用，供增量对比／
 *                                     垃圾回收，不上传 COS）
 *
 * S3（h1 版本根清单，2026-09-27）：manifest 分片原本是固定路径、原地覆盖，
 * 一次发布的 1,296 个分片不是原子切换、也没法让测试站与正式站各看各的数据
 * 版本。改法见上：分片本身按内容哈希命名，每次发布另生成一份不可变的
 * roots/<key>.json 列出本版全部分片的文件名，manifest-root.json 退化成
 * 「当前指针指向哪个 root」的短缓存指针——前端取数变成
 * 指针→root→分片→entry 四级（见 cos-storage.ts）。
 * 分片／roots 文件的孤儿判定也相应从「本地没有就删」改成「不被任何在用
 * root 引用」，在 sync 端由 `runRootsRetention`（`lib/h1-sync-core.mjs` +
 * `lib/h1-roots.mjs`）实现，本脚本只管产出，不管清理。
 *
 * dataCommitKey 不能只用 draft 仓的 commitId：整理本／全文的内容由 book-text
 * 的 textCommitId 决定，若两个 lane 都只用 commitId 当版本 key，book-text
 * 单独更新（deploy.yml 本来就会因为它触发部署）时 entry 侧文件全部原地不动，
 * 但这里用的是同一个 dataCommitKey 生成函数（对 dataCommit 全量三个字段哈希），
 * 所以哪怕 entry 内容真的没变，key 也只在三仓任一个变化时才变——不会用一个
 * 已经存在的 key 覆盖出不同内容（见 h1-hash-common.mjs 的 dataCommitKey 注释）。
 *
 * public/data-h1/ **跨次运行保留**（不像 bundle-data.mjs 那样每次清空 OUT_DIR）：
 * 这样未变的 entry/<id>.<hash>.json 不需要重写，sync 端也不需要重传；只有本轮
 * 新增/变化的 id 才会有新文件、旧哈希文件会被当场清理（垃圾回收，见 gcStaleEntryFiles）。
 * 首次运行或 H1_CLEAN=1 时按全量对待。roots/ 目录例外：每轮只保留本轮这一个
 * 文件（本地暂存区没有跨版本保留的必要，真正的跨版本保留是 COS 端的事）。
 *
 * 用法：
 *   node scripts/bundle-hashed.mjs
 *   H1_OUT_DIR=/path node scripts/bundle-hashed.mjs     # 默认 public/data-h1
 *   H1_CLEAN=1 node scripts/bundle-hashed.mjs           # 忽略旧状态，视全部为新增
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { resolveDataDirs } from './lib/data-dirs.mjs';
import { ensureDir, readJson, hash8, writeHashedShards, dataCommitKey } from './lib/h1-hash-common.mjs';
import { buildPromotionShards } from './lib/h1-promotions.mjs';


const { dataDir: DATA_DIR, h1Dir: OUT_DIR } = resolveDataDirs();
const ENTRY_SRC_DIR = join(DATA_DIR, 'entry');
const VERSION_FILE = join(DATA_DIR, 'version.json');
const PROMOTIONS_SRC = join(DATA_DIR, 'promotions.json');
const CLEAN = process.env.H1_CLEAN === '1';

// 分片键长度：取 id 末 2 位。id 字母表是 0-9a-z（base36），2 位 = 1296 个可能值。
const SHARD_KEY_LEN = 2;
const SHARD_SPACE = 36 ** SHARD_KEY_LEN;

const ENTRY_DIR = join(OUT_DIR, 'entry');
const MANIFEST_DIR = join(OUT_DIR, 'manifest');
const PROMOTIONS_DIR = join(OUT_DIR, 'promotions');
const ROOTS_DIR = join(OUT_DIR, 'roots');
const MANIFEST_ROOT_FILE = join(OUT_DIR, 'manifest-root.json');
const STATE_FILE = join(OUT_DIR, '.manifest-state.json');

function shardKeyFor(id) { return id.slice(-SHARD_KEY_LEN); }

function loadState() {
    if (CLEAN || !existsSync(STATE_FILE)) return {};
    try {
        return readJson(STATE_FILE);
    } catch (e) {
        console.warn(`  ⚠ 旧状态读取失败（${e.message}），按全量重建对待`);
        return {};
    }
}

// ─── 1. 扫源、算哈希、写 entry/<id>.<hash8>.json ───

function bundleEntries() {
    if (!existsSync(ENTRY_SRC_DIR)) {
        console.error(`❌ ${ENTRY_SRC_DIR} 不存在，请先跑 bundle-data.mjs`);
        process.exit(1);
    }

    const oldState = loadState();
    const newState = {};
    const files = readdirSync(ENTRY_SRC_DIR).filter(f => f.endsWith('.json'));

    ensureDir(ENTRY_DIR);

    let scanned = 0;
    let newEntryFilesWritten = 0;
    let bytesWritten = 0;

    for (const fname of files) {
        const id = fname.slice(0, -'.json'.length);
        const buf = readFileSync(join(ENTRY_SRC_DIR, fname));
        const h = hash8(buf);
        newState[id] = h;
        scanned++;

        if (oldState[id] !== h) {
            const dest = join(ENTRY_DIR, `${id}.${h}.json`);
            if (!existsSync(dest)) {
                writeFileSync(dest, buf);
                newEntryFilesWritten++;
                bytesWritten += buf.length;
            }
        }
    }

    return { oldState, newState, scanned, newEntryFilesWritten, bytesWritten };
}

// ─── 2. 垃圾回收：旧哈希不再对应现状的 entry 文件删掉 ───
//
// id 内容变了（哈希变）或 id 整条消失（升格墓碑/删除）时，旧文件名
// entry/<id>.<oldHash>.json 不会再被任何 manifest 引用，留着只会让
// COS 桶无限增长。删除条件很窄：只删「旧状态里有、且新状态要么没有
// 这个 id、要么哈希对不上」这一种文件，不碰其余任何文件。

function gcStaleEntryFiles(oldState, newState) {
    let removed = 0;
    for (const [id, oldHash] of Object.entries(oldState)) {
        const newHash = newState[id];
        if (newHash === oldHash) continue; // 未变，保留
        const stalePath = join(ENTRY_DIR, `${id}.${oldHash}.json`);
        if (existsSync(stalePath)) {
            unlinkSync(stalePath);
            removed++;
        }
    }
    return removed;
}

// ─── 3. manifest 分片：id → hash8，按后缀分片，分片本身也按内容哈希命名 ───

function bundleManifest(newState) {
    const shards = {};
    for (const [id, h] of Object.entries(newState)) {
        const k = shardKeyFor(id);
        (shards[k] ??= {})[id] = h;
    }
    // writeHashedShards 已经把「不再有任何 id 落入的分片键」与「同一分片键内容
    // 变了、旧哈希文件不再对应现状」两种情况都当垃圾回收掉，见 h1-hash-common.mjs。
    return writeHashedShards(MANIFEST_DIR, shards);
}

// ─── 3b. 升格对照表分片（PH）：草稿 id → 正式 id，与 manifest 同一套后缀分片 ───
//
// 读 bundle-data.mjs 复制出来的 promotions.json。文件不存在（或解析失败）时
// 返回 null：root 里就不写 promotionShards 字段，服务端据此知道「这一版没有对照表
// 信息」，照旧走客户端查表；文件存在但是空表时写 {}，服务端据此确定「没有升格」。

function bundlePromotions() {
    let raw = null;
    if (existsSync(PROMOTIONS_SRC)) {
        try {
            raw = readJson(PROMOTIONS_SRC);
        } catch (e) {
            console.warn(`  ⚠ ${PROMOTIONS_SRC} 解析失败（${e.message}），本轮 root 不带升格对照表`);
        }
    } else {
        console.warn(`  ⚠ ${PROMOTIONS_SRC} 不存在，本轮 root 不带升格对照表`);
    }
    const { shards, count, skipped } = raw ? buildPromotionShards(raw, SHARD_KEY_LEN) : { shards: {}, count: 0, skipped: 0 };
    // 没有对照表时也调一次（传空）：清掉本地暂存区里上一轮的分片
    const stat = writeHashedShards(PROMOTIONS_DIR, shards);
    return raw ? { ...stat, count, skipped } : { ...stat, count, skipped, absent: true };
}

// ─── 4. dataCommit（供 roots 文档与指针共用） ───

function readDataCommit() {
    if (!existsSync(VERSION_FILE)) {
        console.warn(`  ⚠ ${VERSION_FILE} 不存在，dataCommit 留 unknown`);
        return { commitId: 'unknown', productionCommitId: 'unknown', textCommitId: 'unknown' };
    }
    const v = readJson(VERSION_FILE);
    return { commitId: v.commitId, productionCommitId: v.productionCommitId, textCommitId: v.textCommitId };
}

// ─── 5. roots/<dataCommitKey>.json（版本根清单，S3）＋ manifest-root.json（指针） ───

function bundleRootsAndPointer(shardStat, promoStat, dataCommit) {
    const commitKey = dataCommitKey(dataCommit);
    const generatedAt = new Date().toISOString();

    const rootDoc = {
        version: 1,
        shardKeyLength: SHARD_KEY_LEN,
        shardSpace: SHARD_SPACE,          // 理论最大分片数（36^2）
        shardCount: shardStat.shardCount, // 本轮实际写出的分片数（有条目落入的）
        generatedAt,
        dataCommit,
        shards: shardStat.shardHashes,    // 后缀 → hash8，前端/sync 靠它拼分片文件名
    };
    if (!promoStat.absent) {
        // PH：升格对照表分片 promotions/<后缀>.<hash8>.json，后缀没有条目就不在表里
        rootDoc.promotionCount = promoStat.count;
        rootDoc.promotionShards = promoStat.shardHashes;
    }

    ensureDir(ROOTS_DIR);
    writeFileSync(join(ROOTS_DIR, `${commitKey}.json`), JSON.stringify(rootDoc));
    // roots/ 本地暂存区不需要跨版本保留（真正的跨版本保留是 COS 端 runRootsRetention
    // 的事），每轮只留本轮这一个文件，避免本地多次运行后越攒越多、被误当新增上传。
    let removedOldRoots = 0;
    for (const fname of readdirSync(ROOTS_DIR)) {
        if (fname !== `${commitKey}.json`) {
            unlinkSync(join(ROOTS_DIR, fname));
            removedOldRoots++;
        }
    }

    const pointer = { version: 2, root: `${commitKey}.json`, generatedAt, dataCommit };
    writeFileSync(MANIFEST_ROOT_FILE, JSON.stringify(pointer));

    return { commitKey, rootDoc, removedOldRoots };
}

// ─── main ───

function main() {
    console.log(`\nbundle-hashed（h1 布局）`);
    console.log(`  source: ${ENTRY_SRC_DIR}`);
    console.log(`  out:    ${OUT_DIR}${CLEAN ? '  (H1_CLEAN=1，按全量重建对待)' : ''}\n`);

    const { oldState, newState, scanned, newEntryFilesWritten, bytesWritten } = bundleEntries();

    if (scanned === 0) {
        console.error('❌ 扫到 0 条条目，检查 public/data/entry 是否已由 bundle-data.mjs 生成');
        process.exit(1);
    }

    const removedEntryFiles = gcStaleEntryFiles(oldState, newState);
    const shardStat = bundleManifest(newState);
    const promoStat = bundlePromotions();
    const dataCommit = readDataCommit();
    const { commitKey, removedOldRoots } = bundleRootsAndPointer(shardStat, promoStat, dataCommit);

    // 状态落盘，供下一轮增量对比
    writeFileSync(STATE_FILE, JSON.stringify(newState));

    console.log(`ENTRY 扫描 ${scanned} 条，新写 ${newEntryFilesWritten} 个 entry 文件（${(bytesWritten / 1024 / 1024).toFixed(2)} MB），回收旧哈希文件 ${removedEntryFiles} 个`);
    console.log(`MANIFEST ${shardStat.shardCount} 片（理论空间 ${SHARD_SPACE}），本轮改动 ${shardStat.changedShards} 片，回收 ${shardStat.removedShards} 片，合计 ${(shardStat.totalBytes / 1024).toFixed(1)} KB`);
    if (promoStat.absent) {
        console.log(`PROMOTIONS 无对照表（root 不带 promotionShards），回收 ${promoStat.removedShards} 片`);
    } else {
        const sizes = promoStat.shardCount ? ` 最大片 ${(promoStat.maxShardBytes / 1024).toFixed(1)} KB` : '';
        console.log(`PROMOTIONS ${promoStat.count} 条（跳过 ${promoStat.skipped}），${promoStat.shardCount} 片，本轮改动 ${promoStat.changedShards} 片，回收 ${promoStat.removedShards} 片，合计 ${(promoStat.totalBytes / 1024).toFixed(1)} KB${sizes}`);
    }
    console.log(`ROOTS roots/${commitKey}.json（本地清理旧 roots 文件 ${removedOldRoots} 个）dataCommit=${dataCommit.commitId?.slice(0, 8)}/${dataCommit.productionCommitId?.slice(0, 8)}/${dataCommit.textCommitId?.slice(0, 8)}`);
    console.log(`POINTER manifest-root.json → root=${commitKey}.json`);
    console.log(`\n✅ bundle-hashed complete → ${OUT_DIR}\n`);
}

main();
