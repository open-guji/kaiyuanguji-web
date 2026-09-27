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
 *   - entry/<id>.<hash8>.json      内容 sha256 前 8 位；内容不变则文件不重写
 *   - manifest/<id 后缀 2 位>.json  id → hash8；按 id **后缀**分片（前缀分片在这批
 *                                  snowflake id 下不均匀，同批同类型 id 前几位
 *                                  几乎恒定，见 29 卡 §2.3），id 是 0-9a-z 的
 *                                  base36 字符，后缀 2 位 = 36×36 = 1296 个可能分片
 *   - manifest-root.json           { shardKeyLength, shardSpace, shardCount,
 *                                    generatedAt, dataCommit }
 *   - .manifest-state.json         上一轮 id→hash8（本脚本自用，供增量对比／
 *                                  垃圾回收，不上传 COS）
 *
 * public/data-h1/ **跨次运行保留**（不像 bundle-data.mjs 那样每次清空 OUT_DIR）：
 * 这样未变的 entry/<id>.<hash>.json 不需要重写，sync 端也不需要重传；只有本轮
 * 新增/变化的 id 才会有新文件、旧哈希文件会被当场清理（垃圾回收，见 gcStaleEntryFiles）。
 * 首次运行或 H1_CLEAN=1 时按全量对待。
 *
 * 用法：
 *   node scripts/bundle-hashed.mjs
 *   H1_OUT_DIR=/path node scripts/bundle-hashed.mjs     # 默认 public/data-h1
 *   H1_CLEAN=1 node scripts/bundle-hashed.mjs           # 忽略旧状态，视全部为新增
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ensureDir, readJson, hash8, writeIfChanged } from './lib/h1-hash-common.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DATA_DIR = resolve(__dirname, '..', 'public', 'data');
const ENTRY_SRC_DIR = join(DATA_DIR, 'entry');
const VERSION_FILE = join(DATA_DIR, 'version.json');
const OUT_DIR = resolve(process.env.H1_OUT_DIR || join(__dirname, '..', 'public', 'data-h1'));
const CLEAN = process.env.H1_CLEAN === '1';

// 分片键长度：取 id 末 2 位。id 字母表是 0-9a-z（base36），2 位 = 1296 个可能值。
const SHARD_KEY_LEN = 2;
const SHARD_SPACE = 36 ** SHARD_KEY_LEN;

const ENTRY_DIR = join(OUT_DIR, 'entry');
const MANIFEST_DIR = join(OUT_DIR, 'manifest');
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

// ─── 3. manifest 分片：id → hash8，按后缀分片 ───

function bundleManifest(newState) {
    ensureDir(MANIFEST_DIR);

    const shards = {};
    for (const [id, h] of Object.entries(newState)) {
        const k = shardKeyFor(id);
        (shards[k] ??= {})[id] = h;
    }

    let changedShards = 0;
    let totalBytes = 0;
    for (const [k, obj] of Object.entries(shards)) {
        const json = Buffer.from(JSON.stringify(obj));
        totalBytes += json.length;
        if (writeIfChanged(join(MANIFEST_DIR, `${k}.json`), json)) changedShards++;
    }

    // 清理不再有任何 id 落入的分片文件（理论上随 id 总数增长几乎不会发生，
    // 但 id 大量减少时会出现，如实处理不留孤儿）。
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

// ─── 4. manifest-root.json ───

function bundleManifestRoot(shardStat) {
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
        shardSpace: SHARD_SPACE,      // 理论最大分片数（36^2）
        shardCount: shardStat.shardCount, // 本轮实际写出的分片数（有条目落入的）
        generatedAt: new Date().toISOString(),
        dataCommit,
    };
    writeFileSync(MANIFEST_ROOT_FILE, JSON.stringify(root));
    return root;
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
    const root = bundleManifestRoot(shardStat);

    // 状态落盘，供下一轮增量对比
    writeFileSync(STATE_FILE, JSON.stringify(newState));

    console.log(`ENTRY 扫描 ${scanned} 条，新写 ${newEntryFilesWritten} 个 entry 文件（${(bytesWritten / 1024 / 1024).toFixed(2)} MB），回收旧哈希文件 ${removedEntryFiles} 个`);
    console.log(`MANIFEST ${shardStat.shardCount} 片（理论空间 ${SHARD_SPACE}），本轮改动 ${shardStat.changedShards} 片，回收 ${shardStat.removedShards} 片，合计 ${(shardStat.totalBytes / 1024).toFixed(1)} KB`);
    console.log(`ROOT  manifest-root.json → shardCount=${root.shardCount} dataCommit=${root.dataCommit.commitId?.slice(0, 8)}/${root.dataCommit.productionCommitId?.slice(0, 8)}/${root.dataCommit.textCommitId?.slice(0, 8)}`);
    console.log(`\n✅ bundle-hashed complete → ${OUT_DIR}\n`);
}

main();
