#!/usr/bin/env node
/**
 * bundle-hashed.mjs — A0-架构原型件一：按内容哈希寻址 + 分片 manifest 的打包原型
 *
 * 对照 bundle-data.mjs 现行方式（entry/{id}.json，固定路径，靠前端 ?v=<commit>
 * 做 CDN cache-bust，发布时全部 URL 一起变）：
 *   - entry/<id>.<hash8>.json         内容哈希入文件名，内容不变文件名不变
 *   - manifest/<前缀>.json            id → hash8，按 id 前缀分片
 *   - text/<id>/<卷file>.<hash8>.<ext> 整理本/全文按卷同机制，另建 manifest-text/<前缀>.json
 *
 * 本脚本只读三仓（book-index 生产、book-index-draft、book-text），只写到本机
 * OUT_DIR（默认系统 tmp，不进 git），不触碰 COS/EdgeOne，不改 public/data。
 *
 * 用法：
 *   node scripts/spike/bundle-hashed.mjs
 *   BOOK_INDEX_PRODUCTION_DIR=/path BOOK_TEXT_DIR=/path node scripts/spike/bundle-hashed.mjs
 *   MANIFEST_PREFIX_LEN=2 node scripts/spike/bundle-hashed.mjs   # 分片前缀长度，默认 2
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, rmSync } from 'fs';
import { join, resolve, dirname, extname, basename } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DRAFT_DIR = resolve(process.env.BOOK_INDEX_DRAFT_DIR || join(__dirname, '..', '..', '..', 'open-guji', 'book-index-draft'));
const PRODUCTION_DIR = resolve(process.env.BOOK_INDEX_PRODUCTION_DIR || join(__dirname, '..', '..', '..', 'open-guji', 'book-index'));
const TEXT_DIR = resolve(process.env.BOOK_TEXT_DIR || join(__dirname, '..', '..', '..', 'open-guji', 'book-text'));
const OUT_DIR = resolve(process.env.SPIKE_OUT_DIR || join(tmpdir(), 'kyg-spike-hash-bundle'));
const PREFIX_LEN = parseInt(process.env.MANIFEST_PREFIX_LEN || '2', 10);
const NUM_SHARDS = 16;

function readJson(p) { return JSON.parse(readFileSync(p, 'utf-8')); }
function hash8(buf) { return createHash('sha256').update(buf).digest('hex').slice(0, 8); }
function ensureDir(d) { mkdirSync(d, { recursive: true }); }

// ─── 1. 载入索引（draft + production，跳过升格墓碑，与 bundle-data.mjs 同一套判断）───

function loadShardedIndex() {
    const merged = { books: {}, collections: {}, works: {}, entities: {} };
    for (const [rootDir, label] of [[DRAFT_DIR, 'draft'], [PRODUCTION_DIR, 'official']]) {
        if (!existsSync(rootDir)) continue;
        const indexDir = join(rootDir, 'index');
        const colPath = join(indexDir, 'collections.json');
        if (existsSync(colPath)) {
            for (const [id, entry] of Object.entries(readJson(colPath))) {
                if (entry?.promoted_to) continue;
                merged.collections[id] = { ...entry, _root: label, _rootDir: rootDir };
            }
        }
        for (const typeKey of ['books', 'works', 'entities']) {
            for (let i = 0; i < NUM_SHARDS; i++) {
                const shardPath = join(indexDir, typeKey, `${i.toString(16)}.json`);
                if (!existsSync(shardPath)) continue;
                for (const [id, entry] of Object.entries(readJson(shardPath))) {
                    if (entry?.promoted_to) continue;
                    merged[typeKey][id] = { ...entry, _root: label, _rootDir: rootDir };
                }
            }
        }
    }
    return merged;
}

// ─── 2. entry/<id>.<hash8>.json + manifest/<前缀>.json ───

function bundleEntries() {
    const index = loadShardedIndex();
    const entryDir = join(OUT_DIR, 'entry');
    ensureDir(entryDir);

    const manifest = {}; // id -> hash8
    let count = 0, bytes = 0, missing = 0;

    for (const typeName of ['works', 'collections', 'books', 'entities']) {
        for (const item of Object.values(index[typeName] ?? {})) {
            const detailPath = join(item._rootDir, item.path);
            if (!existsSync(detailPath)) { missing++; continue; }
            const buf = readFileSync(detailPath);
            const h = hash8(buf);
            manifest[item.id] = h;
            const dest = join(entryDir, `${item.id}.${h}.json`);
            if (!existsSync(dest)) writeFileSync(dest, buf);
            count++;
            bytes += buf.length;
        }
    }

    writeManifest('manifest', manifest);
    return { count, bytes, missing, manifest };
}

// ─── 3. text/<id>/<卷file>.<hash8>.<ext>（collated_edition/juan + full_text）+ manifest-text ───

function walkAssetFiles(dir, out) {
    if (!existsSync(dir)) return out;
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) walkAssetFiles(full, out);
        else out.push(full);
    }
    return out;
}

function bundleText() {
    const index = loadShardedIndex();
    const textDir = join(OUT_DIR, 'text');
    ensureDir(textDir);

    const manifestText = {}; // id -> { file: hash8 }
    let count = 0, bytes = 0, idsWithAssets = 0;

    for (const typeName of ['works', 'books']) {
        for (const item of Object.values(index[typeName] ?? {})) {
            const assetDir = join(TEXT_DIR, dirname(item.path), item.id);
            if (!existsSync(assetDir)) continue;
            const files = walkAssetFiles(assetDir, []);
            if (files.length === 0) continue;
            idsWithAssets++;
            const idManifest = {};
            for (const f of files) {
                const buf = readFileSync(f);
                const h = hash8(buf);
                const rel = f.slice(assetDir.length + 1); // e.g. collated_edition/juan/007.json
                const flatName = rel.replace(/[\\/]/g, '__');
                const ext = extname(flatName);
                const base = flatName.slice(0, -ext.length || undefined);
                idManifest[rel] = h;
                const destDir = join(textDir, item.id);
                ensureDir(destDir);
                const dest = join(destDir, `${base}.${h}${ext}`);
                if (!existsSync(dest)) writeFileSync(dest, buf);
                count++;
                bytes += buf.length;
            }
            manifestText[item.id] = idManifest;
        }
    }

    writeManifest('manifest-text', manifestText, true);
    return { count, bytes, idsWithAssets };
}

// ─── 分片 manifest 写盘 + 统计 ───

// 分片键用 id **后缀**，不用前缀：实测 snowflake id 的前几位是时间戳高位，
// 同一时期批量生成的 id 前缀几乎相同（本仓 95054 个 Work 的 id 前 2 位
// 清一色 "d5"），按前缀分片会把 95% 的条目都堆进同一片；换成后缀（低位，
// 序列/随机段）后 1296 片里最小最大片相差不到 15 倍，基本均匀。
function shardKeyFor(id) {
    return id.slice(-PREFIX_LEN);
}

function writeManifest(subdir, map, isNested = false) {
    const dir = join(OUT_DIR, subdir);
    if (existsSync(dir)) rmSync(dir, { recursive: true });
    ensureDir(dir);
    const shards = {};
    for (const [id, val] of Object.entries(map)) {
        const k = shardKeyFor(id);
        (shards[k] ??= {})[id] = val;
    }
    let totalBytes = 0;
    const sizes = [];
    for (const [k, obj] of Object.entries(shards)) {
        const json = JSON.stringify(obj);
        writeFileSync(join(dir, `${k}.json`), json);
        totalBytes += Buffer.byteLength(json);
        sizes.push(Buffer.byteLength(json));
    }
    sizes.sort((a, b) => a - b);
    const n = sizes.length;
    const stat = n === 0 ? null : {
        shardCount: n,
        totalBytes,
        minBytes: sizes[0],
        p50Bytes: sizes[Math.floor(n * 0.5)],
        p90Bytes: sizes[Math.floor(n * 0.9)],
        maxBytes: sizes[n - 1],
        avgBytes: Math.round(totalBytes / n),
    };
    console.log(`MANIFEST ${subdir}: ${n} 片，共 ${(totalBytes / 1024).toFixed(1)} KB，单片 min/p50/p90/max = ${stat ? `${stat.minBytes}/${stat.p50Bytes}/${stat.p90Bytes}/${stat.maxBytes} B` : 'n/a'}`);
    return stat;
}

// ─── main ───

function main() {
    console.log(`\nbundle-hashed spike`);
    console.log(`  production: ${PRODUCTION_DIR}${existsSync(PRODUCTION_DIR) ? '' : '  ⚠ 不存在'}`);
    console.log(`  draft:      ${DRAFT_DIR}${existsSync(DRAFT_DIR) ? '' : '  ⚠ 不存在'}`);
    console.log(`  text:       ${TEXT_DIR}${existsSync(TEXT_DIR) ? '' : '  ⚠ 不存在'}`);
    console.log(`  out:        ${OUT_DIR}`);
    console.log(`  prefix len: ${PREFIX_LEN}\n`);

    if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true });
    ensureDir(OUT_DIR);

    const t0 = Date.now();
    const e = bundleEntries();
    const tEntries = Date.now() - t0;
    if (e.count === 0) {
        console.error('❌ 扫到 0 条条目，检查 BOOK_INDEX_PRODUCTION_DIR/BOOK_INDEX_DRAFT_DIR 是否指对了目录');
        process.exit(1);
    }
    console.log(`ENTRY ${e.count} 条，${(e.bytes / 1024 / 1024).toFixed(1)} MB，缺文件 ${e.missing} 条，耗时 ${tEntries} ms`);

    const t1 = Date.now();
    const tx = bundleText();
    const tText = Date.now() - t1;
    console.log(`TEXT  ${tx.count} 个卷/全文文件（${tx.idsWithAssets} 个条目有资产），${(tx.bytes / 1024 / 1024).toFixed(1)} MB，耗时 ${tText} ms`);
    if (tx.count === 0) {
        console.warn('⚠ 扫到 0 个卷/全文文件，检查 BOOK_TEXT_DIR 是否指对了目录');
    }

    const totalMs = Date.now() - t0;
    console.log(`\nTOTAL 耗时 ${totalMs} ms（entry ${tEntries} ms + text ${tText} ms）`);

    // 按 200 万条外推（entry 端；text 端规模与条目数不同比例增长，另在报告里单独估）
    const scaleFactor = 2_000_000 / e.count;
    console.log(`EXTRAPOLATE ×${scaleFactor.toFixed(2)}（200 万 / 现有 ${e.count} 条）→ entry 阶段预估 ${(tEntries * scaleFactor / 1000).toFixed(1)} s`);

    // dump summary json for report script to pick up
    writeFileSync(join(OUT_DIR, '_summary.json'), JSON.stringify({
        entry: { count: e.count, bytes: e.bytes, missing: e.missing, ms: tEntries },
        text: { count: tx.count, bytes: tx.bytes, idsWithAssets: tx.idsWithAssets, ms: tText },
        totalMs,
        prefixLen: PREFIX_LEN,
        scaleFactorTo2M: scaleFactor,
    }, null, 2));

    console.log(`\n✅ bundle-hashed complete → ${OUT_DIR}\n`);
}

main();
