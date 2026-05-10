#!/usr/bin/env node
/**
 * bundle-data.mjs — 将 book-index-draft 的散落 JSON 文件打包为少量 chunk
 *
 * 数据分层（L0 已剥离 — 23 MB index.json 不再生成）：
 * - L1: public/data/chunks/{prefix}.json — 按 ID 前缀分桶的详情数据
 * - L2: public/data/tiyao/juan-{start}-{end}.json — 整理本提要（按 10 卷分组）
 * - meta.json — 轻量计数（< 1 KB），HomePage 统计用
 * - search/* — MiniSearch 倒排索引，搜索 worker 用
 *
 * 用法：
 *   node scripts/bundle-data.mjs                          # 默认 ../book-index-draft
 *   node scripts/bundle-data.mjs /path/to/book-index-draft
 *   BOOK_INDEX_DRAFT_DIR=/path node scripts/bundle-data.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync, rmSync, copyFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

// ─── 配置 ───

const __dirname = dirname(fileURLToPath(import.meta.url));

const DRAFT_DIR = resolve(
    process.argv[2]
    || process.env.BOOK_INDEX_DRAFT_DIR
    || join(__dirname, '..', '..', 'book-index-draft')
);
const OUT_DIR = resolve(__dirname, '..', 'public', 'data');

const TIYAO_DIR = join(DRAFT_DIR, 'data', 'siku-catalog', 'volumes');
const TIYAO_GROUP_SIZE = 10;

// ─── 工具 ───

function readJson(path) {
    return JSON.parse(readFileSync(path, 'utf-8'));
}

function writeJson(path, data) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data), 'utf-8');
}

function ensureDir(dir) {
    mkdirSync(dir, { recursive: true });
}

// 复制 items/{id}/ 到 public/data/items/{id}/，并把 collated_edition/text/*.md
// 重命名为 *.txt（EdgeOne 默认只对 text/plain 等做 wire-gzip，不对 text/markdown
// 压缩，1MB+ 的整理本文本不压缩会拖慢国内移动网络的加载）。
// 源仓库 book-index-draft 仍保留 .md 后缀，仅打包产物改名。
function copyDirRecursive(src, dest) {
    mkdirSync(dest, { recursive: true });
    for (const name of readdirSync(src)) {
        const srcPath = join(src, name);
        const stat = statSync(srcPath);
        if (stat.isDirectory()) {
            copyDirRecursive(srcPath, join(dest, name));
        } else {
            const destName = name.endsWith('.md') ? name.slice(0, -3) + '.txt' : name;
            copyFileSync(srcPath, join(dest, destName));
        }
    }
}

const NUM_SHARDS = 16;

// ─── 内部：合并分片索引（不再写入 index.json，仅供 L1/meta/recommended hydrate 使用）───

function loadShardedIndex() {
    const indexDir = join(DRAFT_DIR, 'index');
    const merged = { books: {}, collections: {}, works: {}, entities: {} };

    // collections (single file)
    const colPath = join(indexDir, 'collections.json');
    if (existsSync(colPath)) {
        merged.collections = readJson(colPath);
    }

    // books / works / entities (16 shards each)
    for (const typeKey of ['books', 'works', 'entities']) {
        for (let i = 0; i < NUM_SHARDS; i++) {
            const shardPath = join(indexDir, typeKey, `${i.toString(16)}.json`);
            if (existsSync(shardPath)) {
                Object.assign(merged[typeKey], readJson(shardPath));
            }
        }
    }

    return merged;
}

// ─── L1: 按 ID 前两字符分桶 ───

function bundleL1() {
    const index = loadShardedIndex();
    const chunks = new Map(); // prefix → { id: detailData }
    let totalEntries = 0;
    let itemFileCount = 0;
    const itemsDir = join(OUT_DIR, 'items');
    const chunksDir = join(OUT_DIR, 'chunks');

    // 清理旧数据
    if (existsSync(chunksDir)) rmSync(chunksDir, { recursive: true });
    if (existsSync(itemsDir)) rmSync(itemsDir, { recursive: true });
    ensureDir(chunksDir);

    for (const [typeName, typeKey] of [['works', 'Work'], ['collections', 'Collection'], ['books', 'Book'], ['entities', 'Entity']]) {
        const items = index[typeName];
        if (!items) continue;

        for (const item of Object.values(items)) {
            const id = item.id;
            const path = item.path; // e.g. "Work/G/Y/L/GYL5215Antw-尚書正義.json"
            const prefix = id.slice(0, 2);

            if (!chunks.has(prefix)) chunks.set(prefix, {});
            const chunk = chunks.get(prefix);

            // 读取详情 JSON → 注入 index-only 标记 → 放入 chunk
            //
            // detail 文件本身没有 has_collated 字段（这是 index 阶段扫
            // collated_edition_index.json 算出来的）。把 index 里的
            // has_collated / has_text / has_image / subtype 注入 chunk，
            // 让 BundleStorage.getEntry / getItem 不再需要触发
            // ensureLoaded() 拉 4 MB 的 index.json。
            const detailPath = join(DRAFT_DIR, path);
            if (existsSync(detailPath)) {
                try {
                    const detail = readJson(detailPath);
                    if (item.has_collated) detail.has_collated = true;
                    if (item.has_text) detail.has_text = true;
                    if (item.has_image) detail.has_image = true;
                    if (item.subtype) detail.subtype = item.subtype;
                    if (item.primary_name) detail.primary_name = item.primary_name;
                    chunk[id] = detail;
                    totalEntries++;
                } catch (e) {
                    console.warn(`  ⚠ Failed to read ${path}: ${e.message}`);
                }
            }

            // 关联文件 → 直接复制到 items/{id}/ 下
            const itemDir = join(DRAFT_DIR, dirname(path), id);
            if (existsSync(itemDir) && statSync(itemDir).isDirectory()) {
                copyDirRecursive(itemDir, join(itemsDir, id));
                itemFileCount++;
            }
        }
    }

    // ─── 自适应前缀拆分 ───

    const TARGET_MB = 1;
    const MAX_PREFIX_LEN = 9;

    /**
     * 递归拆分：如果 data 序列化后超过 TARGET_MB，
     * 按 key 的第 prefixLen 个字符分桶，继续递归。
     * 返回 [prefix, data][] 列表。
     */
    function splitChunk(prefix, data, prefixLen) {
        const json = JSON.stringify(data);
        const sizeMB = Buffer.byteLength(json) / 1024 / 1024;

        if (sizeMB <= TARGET_MB || prefixLen >= MAX_PREFIX_LEN) {
            return [[prefix, data]];
        }

        // 按第 prefixLen 个字符分桶（取 key 中 ID 部分）
        const subGroups = new Map();
        for (const [key, val] of Object.entries(data)) {
            const ch = key.length > prefixLen ? key[prefixLen] : '_';
            if (!subGroups.has(ch)) subGroups.set(ch, {});
            subGroups.get(ch)[key] = val;
        }

        // 递归拆分每个子桶
        const result = [];
        for (const [ch, subData] of subGroups) {
            result.push(...splitChunk(prefix + ch, subData, prefixLen + 1));
        }
        return result;
    }

    // 对每个初始 2-char chunk 递归拆分
    const finalChunks = [];
    for (const [prefix, data] of chunks) {
        finalChunks.push(...splitChunk(prefix, data, 2));
    }

    // 写入文件 + 收集 manifest
    const manifest = [];
    for (const [prefix, data] of finalChunks) {
        writeJson(join(chunksDir, `${prefix}.json`), data);
        manifest.push(prefix);
    }
    manifest.sort();
    writeJson(join(chunksDir, '_manifest.json'), manifest);

    console.log(`L1  ${totalEntries} entries → ${finalChunks.length} chunk files + manifest`);
    let totalSize = 0;
    for (const [prefix, data] of finalChunks.sort((a, b) => a[0].localeCompare(b[0]))) {
        const size = Buffer.byteLength(JSON.stringify(data)) / 1024 / 1024;
        totalSize += size;
        if (size > 0.1) {
            console.log(`    ${prefix}.json  (${size.toFixed(1)} MB, ${Object.keys(data).length} keys)`);
        }
    }
    console.log(`    chunks total: ${totalSize.toFixed(1)} MB`);
    if (itemFileCount > 0) {
        console.log(`    items: ${itemFileCount} directories copied to items/`);
    }
}

// ─── L2: 提要按卷组打包 ───

function bundleL2() {
    if (!existsSync(TIYAO_DIR)) {
        console.log('L2  skipped (no tiyao data)');
        return;
    }

    const files = readdirSync(TIYAO_DIR)
        .filter(f => f.match(/^juan\d+\.json$/))
        .sort();

    if (files.length === 0) {
        console.log('L2  skipped (no juan files)');
        return;
    }

    const tiyaoDir = join(OUT_DIR, 'tiyao');
    ensureDir(tiyaoDir);

    // 按组打包
    let groupCount = 0;
    const maxJuan = files.length;
    const totalGroups = Math.ceil(maxJuan / TIYAO_GROUP_SIZE);

    for (let g = 0; g < totalGroups; g++) {
        const start = g * TIYAO_GROUP_SIZE + 1;
        const end = Math.min((g + 1) * TIYAO_GROUP_SIZE, maxJuan);
        const group = {};

        for (let j = start; j <= end; j++) {
            const fname = `juan${String(j).padStart(2, '0')}.json`;
            const fpath = join(TIYAO_DIR, fname);
            if (existsSync(fpath)) {
                try {
                    group[fname] = readJson(fpath);
                } catch (e) {
                    console.warn(`  ⚠ Failed to read ${fname}: ${e.message}`);
                }
            }
        }

        if (Object.keys(group).length > 0) {
            const pad = n => String(n).padStart(3, '0');
            writeJson(join(tiyaoDir, `juan-${pad(start)}-${pad(end)}.json`), group);
            groupCount++;
        }
    }

    console.log(`L2  ${files.length} juan files → ${groupCount} tiyao chunks`);
}

// ─── 轻量元数据（meta.json）：让 /book-index 首屏不再下 4 MB index ───
//
// HomePage / IndexBrowser 之前为了显示「N 部作品 / N 部书 / 资源覆盖 / subtype 直方图」
// 等几个数字会调用 getAllEntries / loadEntries 等触发 index.json 全量下载。
// 把这些数字预算到 meta.json (< 1 KB)，BundleStorage.getCounts() 优先读它。

function bundleMeta() {
    const index = loadShardedIndex();
    const counts = {
        works: Object.keys(index.works ?? {}).length,
        books: Object.keys(index.books ?? {}).length,
        collections: Object.keys(index.collections ?? {}).length,
        entities: Object.keys(index.entities ?? {}).length,
    };
    let hasText = 0, hasImage = 0;
    const subtypeStats = {};
    for (const item of Object.values(index.works ?? {})) {
        if (item.has_text) hasText++;
        if (item.has_image) hasImage++;
        if (item.subtype) subtypeStats[item.subtype] = (subtypeStats[item.subtype] ?? 0) + 1;
    }
    const meta = {
        ...counts,
        resourceCounts: { hasText, hasImage },
        subtypeStats,
    };
    writeJson(join(OUT_DIR, 'meta.json'), meta);
    const size = Buffer.byteLength(JSON.stringify(meta));
    console.log(
        `META meta.json (${counts.works}w/${counts.books}b/${counts.collections}c/${counts.entities}e, ${size} B)`
    );
}

// ─── 复制独立数据文件（resource.json, recommended.json） ───

function bundleExtraFiles() {
    // resource* 直接复制
    for (const fname of ['resource.json', 'resource-catalog.json', 'resource-collection.json', 'resource-site.json']) {
        const src = join(DRAFT_DIR, fname);
        if (existsSync(src)) {
            const data = readFileSync(src, 'utf-8');
            writeFileSync(join(OUT_DIR, fname), data, 'utf-8');
            const size = (Buffer.byteLength(data) / 1024).toFixed(0);
            console.log(`EX  ${fname} copied (${size} KB)`);
        } else {
            console.log(`EX  ${fname} not found, skipped`);
        }
    }

    // recommended.json: hydrate items 加上 IndexEntry 元数据，让 HomePage
    // 直接渲染，不再为每个 ID 触发一次 transport.getEntry / chunk fetch。
    const recSrc = join(DRAFT_DIR, 'recommended.json');
    if (existsSync(recSrc)) {
        const rec = readJson(recSrc);
        const index = loadShardedIndex();
        const lookup = new Map();
        for (const typeName of ['works', 'books', 'collections', 'entities']) {
            for (const item of Object.values(index[typeName] ?? {})) {
                lookup.set(item.id, { ...item, type: typeName.slice(0, -1) });
            }
        }
        let hydrated = 0, missed = 0;
        for (const group of rec.groups ?? []) {
            for (const item of group.items ?? []) {
                const idx = lookup.get(item.id);
                if (idx) {
                    if (!item.title) item.title = idx.title || idx.name || idx.primary_name;
                    item.type = idx.type;
                    if (idx.author) item.author = idx.author;
                    if (idx.dynasty) item.dynasty = idx.dynasty;
                    if (idx.role) item.role = idx.role;
                    if (idx.edition) item.edition = idx.edition;
                    if (idx.has_text) item.has_text = true;
                    if (idx.has_image) item.has_image = true;
                    if (idx.has_collated) item.has_collated = true;
                    if (idx.subtype) item.subtype = idx.subtype;
                    if (idx.primary_name) item.primary_name = idx.primary_name;
                    hydrated++;
                } else {
                    missed++;
                }
            }
        }
        const data = JSON.stringify(rec);
        writeFileSync(join(OUT_DIR, 'recommended.json'), data, 'utf-8');
        const size = (Buffer.byteLength(data) / 1024).toFixed(1);
        console.log(`EX  recommended.json hydrated (${hydrated} items + ${missed} missed, ${size} KB)`);
    } else {
        console.log(`EX  recommended.json not found, skipped`);
    }
}

// ─── 版本信息（记录 book-index-draft 的 commit） ───

function bundleVersion() {
    let commitId = 'unknown';
    let commitDate = '';

    try {
        commitId = execSync('git rev-parse HEAD', { cwd: DRAFT_DIR, encoding: 'utf-8' }).trim();
        commitDate = execSync('git log -1 --format=%cI', { cwd: DRAFT_DIR, encoding: 'utf-8' }).trim();
    } catch {
        // CI 中 --depth 1 clone 也能拿到 HEAD，如果失败则留默认值
        console.warn('  ⚠ Could not read git info from book-index-draft');
    }

    const version = {
        commitId,
        commitDate,
        bundleDate: new Date().toISOString(),
    };

    writeJson(join(OUT_DIR, 'version.json'), version);
    console.log(`VER version.json (commit: ${commitId.slice(0, 8)}, date: ${commitDate})`);
}

// ─── Index 完整性检查 ───
//
// 扫描 Work/Book/Collection 目录下所有条目文件（文件名格式 {11位ID}-*.json），
// 验证每个 ID 都已存在于 index 分片中。
// 发现缺失时输出错误并 exit(1)，阻止生成错误的打包产物。

function checkIndex() {
    console.log('IDX checking index consistency...');

    // 加载所有已 index 的 ID
    const indexed = new Set();
    const indexDir = join(DRAFT_DIR, 'index');

    const colPath = join(indexDir, 'collections.json');
    if (existsSync(colPath)) {
        for (const id of Object.keys(readJson(colPath))) indexed.add(id);
    }
    for (const typeKey of ['books', 'works', 'entities']) {
        for (let i = 0; i < NUM_SHARDS; i++) {
            const shardPath = join(indexDir, typeKey, `${i.toString(16)}.json`);
            if (existsSync(shardPath)) {
                for (const id of Object.keys(readJson(shardPath))) indexed.add(id);
            }
        }
    }

    // 扫描条目文件：文件名必须匹配 {ID}-*.json (ID为11-13位字母数字)
    const ITEM_FILE_RE = /^[A-Za-z0-9]{11,13}-.+\.json$/;
    const missing = [];

    const walkDir = (dir) => {
        for (const entry of readdirSync(dir)) {
            const full = join(dir, entry);
            if (statSync(full).isDirectory()) {
                walkDir(full);
            } else if (ITEM_FILE_RE.test(entry)) {
                const id = entry.split('-')[0];
                if (!indexed.has(id)) {
                    missing.push({ id, path: full.replace(DRAFT_DIR, '').replace(/\\/g, '/') });
                }
            }
        }
    };

    for (const typeDir of ['Work', 'Book', 'Collection', 'Entity']) {
        const dir = join(DRAFT_DIR, typeDir);
        if (existsSync(dir)) walkDir(dir);
    }

    if (missing.length > 0) {
        console.error(`\n❌ Index check failed: ${missing.length} item(s) exist as files but are missing from the index:`);
        for (const { id, path } of missing) {
            console.error(`   ${id}  ${path}`);
        }
        console.error('\n   Run: book-index reindex --root <draft-dir>  to fix.\n');
        process.exit(1);
    }

    console.log(`IDX index consistent (${indexed.size} entries indexed)\n`);
}

// ─── Main ───

console.log(`\nbundle-data: ${DRAFT_DIR}`);
console.log(`output:      ${OUT_DIR}\n`);

if (!existsSync(DRAFT_DIR)) {
    console.error(`❌ book-index-draft directory not found: ${DRAFT_DIR}`);
    console.error('   Set BOOK_INDEX_DRAFT_DIR or pass path as argument');
    process.exit(1);
}

checkIndex();
bundleMeta();
bundleL1();
bundleL2();
bundleExtraFiles();
bundleVersion();

// 清理旧的 L0 / search_s 产物（避免上线后部署目录残留导致客户端误下载）
for (const stale of ['index.json', 'search_s.json']) {
    const p = join(OUT_DIR, stale);
    if (existsSync(p)) {
        unlinkSync(p);
        console.log(`CLR removed legacy ${stale}`);
    }
}

// ─── 搜索索引（MiniSearch，自给自足从 shard 重建） ───
try {
    execSync('node scripts/build-search-index.mjs', {
        cwd: resolve(__dirname, '..'),
        stdio: 'inherit',
    });
} catch (err) {
    console.error('❌ build-search-index.mjs failed');
    process.exit(1);
}

console.log('\n✅ bundle-data complete\n');
