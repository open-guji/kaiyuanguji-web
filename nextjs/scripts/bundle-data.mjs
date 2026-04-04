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

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
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

const NUM_SHARDS = 16;

// ─── L0: 合并分片索引 → index.json ───

function loadShardedIndex() {
    const indexDir = join(DRAFT_DIR, 'index');
    const merged = { books: {}, collections: {}, works: {} };

    // collections (single file)
    const colPath = join(indexDir, 'collections.json');
    if (existsSync(colPath)) {
        merged.collections = readJson(colPath);
    }

    // books and works (16 shards each)
    for (const typeKey of ['books', 'works']) {
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
    const total = Object.keys(merged.books).length + Object.keys(merged.collections).length + Object.keys(merged.works).length;
    console.log(`L0  index.json merged from shards (${total} entries, ${size} MB)`);
}

// ─── L1: 按 ID 前两字符分桶 ───

function bundleL1() {
    const index = loadShardedIndex();
    const chunks = new Map(); // prefix → { id: detailData, ... }
    let totalEntries = 0;

    for (const [typeName, typeKey] of [['works', 'Work'], ['collections', 'Collection'], ['books', 'Book']]) {
        const items = index[typeName];
        if (!items) continue;

        for (const item of Object.values(items)) {
            const id = item.id;
            const path = item.path; // e.g. "Work/G/Y/L/GYL5215Antw-尚書正義.json"
            const prefix = id.slice(0, 2);

            if (!chunks.has(prefix)) chunks.set(prefix, {});
            const chunk = chunks.get(prefix);

            // 读取详情 JSON
            const detailPath = join(DRAFT_DIR, path);
            if (existsSync(detailPath)) {
                try {
                    chunk[id] = readJson(detailPath);
                    totalEntries++;
                } catch (e) {
                    console.warn(`  ⚠ Failed to read ${path}: ${e.message}`);
                }
            }

            // 查找关联数据：volume_book_mapping（Collection 的资源目录）
            const itemDir = join(DRAFT_DIR, dirname(path), id);
            if (existsSync(itemDir) && statSync(itemDir).isDirectory()) {
                for (const resDir of readdirSync(itemDir)) {
                    const mappingPath = join(itemDir, resDir, 'volume_book_mapping.json');
                    if (existsSync(mappingPath)) {
                        try {
                            chunk[`${id}/${resDir}/volume_book_mapping`] = readJson(mappingPath);
                        } catch (e) {
                            console.warn(`  ⚠ Failed to read mapping ${mappingPath}: ${e.message}`);
                        }
                    }
                }

                // collated_edition_index + collated_edition juan files
                const ceiPath = join(itemDir, 'collated_edition_index.json');
                if (existsSync(ceiPath)) {
                    try {
                        chunk[`${id}/collated_edition_index`] = readJson(ceiPath);
                    } catch (e) {
                        console.warn(`  ⚠ Failed to read collated_edition_index: ${e.message}`);
                    }

                    // Pack individual collated edition juan files
                    const ceDir = join(itemDir, 'collated_edition');
                    if (existsSync(ceDir) && statSync(ceDir).isDirectory()) {
                        for (const ceFile of readdirSync(ceDir).filter(f => f.endsWith('.json'))) {
                            try {
                                chunk[`${id}/collated_edition/${ceFile}`] = readJson(join(ceDir, ceFile));
                            } catch (e) {
                                console.warn(`  ⚠ Failed to read collated_edition/${ceFile}: ${e.message}`);
                            }
                        }
                    }
                }
            }
        }
    }

    // 写入 chunk 文件（超过 20MB 的按 ID 第3字符拆分）
    const chunksDir = join(OUT_DIR, 'chunks');
    // 清空旧的 chunk 文件
    if (existsSync(chunksDir)) {
        for (const f of readdirSync(chunksDir)) unlinkSync(join(chunksDir, f));
    }
    ensureDir(chunksDir);
    const MAX_CHUNK_MB = 20;
    let fileCount = 0;

    for (const [prefix, data] of chunks) {
        const json = JSON.stringify(data);
        const sizeMB = Buffer.byteLength(json) / 1024 / 1024;

        if (sizeMB <= MAX_CHUNK_MB) {
            writeJson(join(chunksDir, `${prefix}.json`), data);
            fileCount++;
        } else {
            // Split by 3rd character of key's ID
            const subChunks = new Map();
            for (const [key, val] of Object.entries(data)) {
                const sub = key.length >= 3 ? key[2] : '_';
                if (!subChunks.has(sub)) subChunks.set(sub, {});
                subChunks.get(sub)[key] = val;
            }
            for (const [sub, subData] of subChunks) {
                writeJson(join(chunksDir, `${prefix}${sub}.json`), subData);
                fileCount++;
            }
            console.log(`    ${prefix}.json split into ${subChunks.size} sub-chunks (was ${sizeMB.toFixed(1)} MB)`);
        }
    }

    console.log(`L1  ${totalEntries} entries → ${fileCount} chunk files`);
    // Print sizes of all chunk files
    for (const f of readdirSync(chunksDir).sort()) {
        const content = readFileSync(join(chunksDir, f), 'utf-8');
        const size = (Buffer.byteLength(content) / 1024 / 1024).toFixed(1);
        const keys = Object.keys(JSON.parse(content)).length;
        console.log(`    ${f}  (${size} MB, ${keys} keys)`);
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

// ─── 简体搜索索引 ───

function bundleSearchS() {
    const index = loadShardedIndex();
    const t2s = OpenCC.Converter({ from: 'tw', to: 'cn' });

    const searchS = {};
    let count = 0;

    for (const [typeName] of [['works'], ['collections'], ['books']]) {
        const items = index[typeName];
        if (!items) continue;

        for (const item of Object.values(items)) {
            const simplified = {};
            const title = item.title || item.name || '';

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

// ─── Main ───

console.log(`\nbundle-data: ${DRAFT_DIR}`);
console.log(`output:      ${OUT_DIR}\n`);

if (!existsSync(DRAFT_DIR)) {
    console.error(`❌ book-index-draft directory not found: ${DRAFT_DIR}`);
    console.error('   Set BOOK_INDEX_DRAFT_DIR or pass path as argument');
    process.exit(1);
}

bundleL0();
bundleSearchS();
bundleL1();
bundleL2();
bundleExtraFiles();

console.log('\n✅ bundle-data complete\n');
