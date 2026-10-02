#!/usr/bin/env node
/**
 * build-search-index.mjs — 构建 L2（浏览器兜底搜索）轻量分片
 *
 * L2 只在 L1（Meili，经 /api/search 代理）不可用时才下载。S1（2026-09-28）起改为
 * 轻量格式：每条只存 id＋书名＋作者＋朝代（＋与原文不同时的简体），浏览器里线性扫描，
 * 不再序列化 MiniSearch 倒排索引。14.7 万条：52 MB → 约 8.7 MB（br 后 7.1 → 2.4 MB）。
 * 格式与检索见 src/lib/search/lite.js。
 *
 * 产物（文件名与 meta.json 形状沿用旧版，deploy.yml／e2e 契约不用改）：
 *   search/core-work-{0..3}.json   work 分 4 片并行加载
 *   search/core-book.json
 *   search/core-collection.json
 *   search/core-entity.json
 *   search/meta.json               { version: 5, format: 'lite', indices: [...] }
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { resolveDataDirs } from './lib/data-dirs.mjs';
import * as OpenCC from 'opencc-js';
import { LITE_FORMAT, encodeLiteRow } from '../src/lib/search/lite.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { dataDir: OUT_DIR } = resolveDataDirs();
const SEARCH_DIR = join(OUT_DIR, 'search');

function readJson(path) {
    return JSON.parse(readFileSync(path, 'utf-8'));
}

function writeJson(path, data) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data), 'utf-8');
}

function ensureSearchDir() {
    mkdirSync(SEARCH_DIR, { recursive: true });
}

/** 条目资料丰富度：整理本 > 全文 > 影像 > 有卷数 > 有作者 */
function richness(e) {
    return (e.has_collated ? 8 : 0) + (e.has_text ? 4 : 0) + (e.has_image ? 2 : 0)
        + (e.juan_count ? 1 : 0) + (e.author ? 1 : 0);
}

/**
 * 按 (groupKey, typeLabel) 产出单类型的轻量行。
 * 别名（additional_titles）与各种展示字段（卷数、有无全文……）都不进 L2：
 * 兜底只保证「按书名、作者搜得到」，完整结果由 L1 负责。
 */
function buildRows(index, searchS, groupKey, typeLabel) {
    const group = index[groupKey];
    if (!group) return [];
    // 行序即同分时的名次（lite.js 的排序是稳定的）：资料越全的排越前，
    // 让「史記」搜出来司馬遷那部（有全文、130 卷）排在同名的佚書前面。
    const entries = Object.values(group)
        .map((e, i) => ({ e, i, r: richness(e) }))
        .sort((x, y) => (y.r - x.r) || (x.i - y.i))
        .map(x => x.e);
    const rows = [];
    for (const entry of entries) {
        const s = searchS[entry.id] || {};
        // entity 的标题字段是 primary_name
        const title = entry.title || (typeLabel === 'entity' ? (entry.primary_name || '') : '');
        rows.push(encodeLiteRow({
            id: entry.id,
            title,
            author: entry.author || '',
            dynasty: entry.dynasty || '',   // 撰人朝代
            titleS: s.t,
            authorS: s.a,
        }));
    }
    return rows;
}

const WORK_SHARD_COUNT = 4;

function buildIndexForType(index, searchS, groupKey, typeLabel) {
    const rows = buildRows(index, searchS, groupKey, typeLabel);
    const shardCount = typeLabel === 'work' ? WORK_SHARD_COUNT : 1;
    const chunkSize = Math.ceil(rows.length / shardCount);

    const shardInfos = [];
    let totalBuildMs = 0;
    for (let i = 0; i < shardCount; i++) {
        const chunk = rows.slice(i * chunkSize, (i + 1) * chunkSize);
        if (chunk.length === 0) continue;
        const t0 = Date.now();
        const json = JSON.stringify(chunk);
        const buildMs = Date.now() - t0;
        totalBuildMs += buildMs;
        const sizeKb = Math.round(Buffer.byteLength(json) / 1024);
        const file = shardCount > 1 ? `core-${typeLabel}-${i}.json` : `core-${typeLabel}.json`;
        ensureSearchDir();
        writeFileSync(join(SEARCH_DIR, file), json, 'utf-8');
        shardInfos.push({ file, sizeKb, docCount: chunk.length });
        const label = (typeLabel + (shardCount > 1 ? `-${i}` : '')).padEnd(12);
        console.log(`SRCH  ${label} ${chunk.length.toString().padStart(6)} docs → ${file} (${sizeKb} KB, built in ${buildMs} ms)`);
    }

    const totalDocs = shardInfos.reduce((s, x) => s + x.docCount, 0);
    const totalSizeKb = shardInfos.reduce((s, x) => s + x.sizeKb, 0);
    if (shardCount > 1) {
        return { type: typeLabel, shards: shardInfos.map(s => s.file), docCount: totalDocs, sizeKb: totalSizeKb, buildMs: totalBuildMs };
    }
    // 某类型 0 条时 shardInfos 为空（如数据仓缺失、或该类型确实没有条目）——
    // 不写 core-{type}.json，meta.json 里对应条目也不带 file，
    // worker init 时会正确跳过该类型（没有文件可 fetch）。
    if (shardInfos.length === 0) {
        return { type: typeLabel, docCount: 0, sizeKb: 0, buildMs: totalBuildMs };
    }
    return { type: typeLabel, file: shardInfos[0].file, docCount: totalDocs, sizeKb: totalSizeKb, buildMs: totalBuildMs };
}

// ─── 主流程 ───

/**
 * 读单个仓（draft 或 production）的 index/ 目录，entry 上打 _root 标签。
 */
function loadRoot(rootDir, rootLabel, merged) {
    if (!existsSync(rootDir)) return;
    const indexDir = join(rootDir, 'index');
    if (!existsSync(indexDir)) return;
    for (const sub of ['books', 'works', 'entities']) {
        const subDir = join(indexDir, sub);
        if (!existsSync(subDir)) continue;
        for (const f of readdirSync(subDir)) {
            if (!f.endsWith('.json')) continue;
            const data = readJson(join(subDir, f));
            for (const [id, entry] of Object.entries(data)) {
                merged[sub][id] = { ...entry, _root: rootLabel };
            }
        }
    }
    const cf = join(indexDir, 'collections.json');
    if (existsSync(cf)) {
        for (const [id, entry] of Object.entries(readJson(cf))) {
            merged.collections[id] = { ...entry, _root: rootLabel };
        }
    }
}

/**
 * 合并 draft + production 两仓的 shard 索引，跳过升格墓碑。
 *
 * 语义与 L1（indexer/full-reindex.mjs 的 iterAllRoots）保持一致：**两仓都收，
 * 只丢墓碑**。不能只留 production —— 那会永久丢掉尚未升格的新条目。
 *
 * 升格后 draft 侧只留 `promoted_to` 墓碑（detail 已 stub 化到只剩标题），
 * 必须跳过，否则索引里全是「裸标题、无作者」的废文档，且会盖掉 production
 * 的完整条目。L1 曾踩过同一个坑（2026-08-25 修），L2 一直没跟上：
 * 修复前线上 L2 的 works docCount=89974，恰好等于 draft 仓 works 总数，
 * 而其中 89972 条是墓碑 —— 也就是说兜底搜索索引里几乎全是废数据，
 * production 的 91219 条完整条目一条都没进去。
 *
 * draft 先写、production 后写覆盖同 ID（与 bundle-data.mjs 的合并顺序一致）。
 */
function loadShardedIndex() {
    const draftDir = process.env.BOOK_INDEX_DRAFT_DIR
        || resolve(__dirname, '..', '..', '..', 'book-index-draft');
    const productionDir = process.env.BOOK_INDEX_PRODUCTION_DIR
        || resolve(__dirname, '..', '..', '..', 'book-index');
    if (!existsSync(join(draftDir, 'index'))) {
        console.error(`❌ index directory not found: ${join(draftDir, 'index')}`);
        process.exit(1);
    }
    if (!existsSync(productionDir)) {
        console.warn(`⚠️  production 仓未找到（${productionDir}）—— L2 只会索引 draft 侧活体条目，已升格的正式条目将全部缺席`);
    }

    const merged = { books: {}, collections: {}, works: {}, entities: {} };
    loadRoot(draftDir, 'draft', merged);
    loadRoot(productionDir, 'official', merged);

    const kept = { books: {}, collections: {}, works: {}, entities: {} };
    let tombstones = 0;
    for (const groupKey of Object.keys(merged)) {
        for (const [id, entry] of Object.entries(merged[groupKey])) {
            if (entry.promoted_to) { tombstones++; continue; }
            kept[groupKey][id] = entry;
        }
    }
    const total = Object.values(kept).reduce((n, g) => n + Object.keys(g).length, 0);
    console.log(`  索引来源：draft + production，跳过 ${tombstones} 个升格墓碑，实收 ${total} 条`);
    return kept;
}

/** 构建搜索专用的繁→简差异表（仅 title/author 与原文不同的条目） */
function buildSearchSimplified(index) {
    const t2s = OpenCC.Converter({ from: 't', to: 'cn' });
    const out = {};
    for (const groupKey of ['works', 'collections', 'books', 'entities']) {
        const group = index[groupKey];
        if (!group) continue;
        for (const item of Object.values(group)) {
            const simplified = {};
            const title = item.title || item.name || item.primary_name || '';
            if (title) {
                const ts = t2s(title);
                if (ts !== title) simplified.t = ts;
            }
            if (item.author) {
                const as = t2s(item.author);
                if (as !== item.author) simplified.a = as;
            }
            if (Object.keys(simplified).length > 0) out[item.id] = simplified;
        }
    }
    return out;
}

function build() {
    const index = loadShardedIndex();
    const searchS = buildSearchSimplified(index);

    const shards = [
        ['works', 'work'],
        ['books', 'book'],
        ['collections', 'collection'],
        ['entities', 'entity'],
    ];
    const indices = shards.map(([gk, tl]) => buildIndexForType(index, searchS, gk, tl));

    const meta = {
        version: 5,
        format: LITE_FORMAT,
        fields: ['title', 'author'],
        indices,
        builtAt: new Date().toISOString(),
    };
    writeJson(join(SEARCH_DIR, 'meta.json'), meta);
    const total = indices.reduce((s, i) => s + i.sizeKb, 0);
    console.log(`SRCH  meta.json written (total ${total} KB across ${indices.length} shards)`);
}

build();
