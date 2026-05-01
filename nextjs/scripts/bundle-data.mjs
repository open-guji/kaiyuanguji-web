#!/usr/bin/env node
/**
 * bundle-data.mjs — 将 book-index-draft 的散落 JSON 文件打包为少量 chunk
 *
 * 数据分层：
 * - L0: public/data/index.json        — 全局索引（直接复制）
 * - L1: public/data/chunks/{XX}.json   — 按 ID 前两字符分桶的详情数据
 * - L2: public/data/tiyao/juan-{start}-{end}.json — 整理本提要（按 10 卷分组）
 *
 * 用法：
 *   node scripts/bundle-data.mjs                          # 默认 ../book-index-draft
 *   node scripts/bundle-data.mjs /path/to/book-index-draft
 *   BOOK_INDEX_DRAFT_DIR=/path node scripts/bundle-data.mjs
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync, cpSync, rmSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import * as OpenCC from 'opencc-js';

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

function copyDirRecursive(src, dest) {
    cpSync(src, dest, { recursive: true });
}

const NUM_SHARDS = 16;

// ─── L0: 合并分片索引 → index.json ───

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

function bundleL0() {
    const indexDir = join(DRAFT_DIR, 'index');
    if (!existsSync(indexDir)) {
        console.error(`❌ index directory not found: ${indexDir}`);
        process.exit(1);
    }
    ensureDir(OUT_DIR);
    const merged = loadShardedIndex();
    const data = JSON.stringify(merged);
    writeFileSync(join(OUT_DIR, 'index.json'), data, 'utf-8');
    const size = (Buffer.byteLength(data) / 1024 / 1024).toFixed(1);
    const total = Object.keys(merged.books).length
        + Object.keys(merged.collections).length
        + Object.keys(merged.works).length
        + Object.keys(merged.entities).length;
    console.log(`L0  index.json merged from shards (${total} entries, ${size} MB)`);
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

            // 读取详情 JSON → 放入 chunk
            const detailPath = join(DRAFT_DIR, path);
            if (existsSync(detailPath)) {
                try {
                    chunk[id] = readJson(detailPath);
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

// ─── 简体搜索索引 ───

function bundleSearchS() {
    const index = loadShardedIndex();
    const t2s = OpenCC.Converter({ from: 'tw', to: 'cn' });

    const searchS = {};
    let count = 0;

    for (const [typeName] of [['works'], ['collections'], ['books'], ['entities']]) {
        const items = index[typeName];
        if (!items) continue;

        for (const item of Object.values(items)) {
            const simplified = {};
            // entity 的标题字段是 primary_name
            const title = item.title || item.name || item.primary_name || '';

            // 标题转简体
            if (title) {
                const ts = t2s(title);
                if (ts !== title) simplified.t = ts;
            }

            // 作者转简体
            if (item.author) {
                const as = t2s(item.author);
                if (as !== item.author) simplified.a = as;
            }

            // 别名转简体
            if (item.additional_titles && item.additional_titles.length > 0) {
                const ats = item.additional_titles.map(t => t2s(t));
                if (ats.some((s, i) => s !== item.additional_titles[i])) {
                    simplified.at = ats;
                }
            }

            // 只存有差异的条目
            if (Object.keys(simplified).length > 0) {
                searchS[item.id] = simplified;
                count++;
            }
        }
    }

    writeJson(join(OUT_DIR, 'search_s.json'), searchS);
    const size = (Buffer.byteLength(JSON.stringify(searchS)) / 1024).toFixed(0);
    console.log(`S   search_s.json generated (${count} entries with simplified text, ${size} KB)`);
}

// ─── 复制独立数据文件（resource.json, recommended.json） ───

function bundleExtraFiles() {
    const files = ['resource.json', 'resource-site.json', 'recommended.json'];
    for (const fname of files) {
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
bundleL0();
bundleMeta();
bundleSearchS();
bundleL1();
bundleL2();
bundleExtraFiles();
bundleVersion();

// ─── 搜索索引（MiniSearch） ───
// 依赖 index.json + search_s.json，所以放在最后。
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
