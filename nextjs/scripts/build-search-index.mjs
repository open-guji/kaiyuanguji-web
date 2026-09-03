#!/usr/bin/env node
/**
 * build-search-index.mjs — 基于 MiniSearch 构建 L0 核心搜索索引
 *
 * 按类型拆分为三个文件，Worker 端并行加载：
 *   public/data/search/core-work.json
 *   public/data/search/core-book.json
 *   public/data/search/core-collection.json
 *   public/data/search/meta.json
 *
 * 索引字段（仅 L0 核心）:
 *   title_search, aliases_search, author_search, dynasty
 *   *_search 字段把繁 + 简（若有差异）拼在一起，使用户输入任一形式皆可命中。
 *
 * 分词: 纯 bigram + CJK 单字段兜底（见 normalize.js），相比 bigram+unigram 约减半 token 数。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import MiniSearch from 'minisearch';
import * as OpenCC from 'opencc-js';
import { tokenize, joinFields } from '../src/lib/search/normalize.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'public', 'data');
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

/** 按 (groupKey, typeLabel) 产出单类型的 docs 数组。*/
function buildDocs(index, searchS, groupKey, typeLabel) {
    const group = index[groupKey];
    if (!group) return [];
    const docs = [];
    for (const entry of Object.values(group)) {
        const s = searchS[entry.id] || {};

        // entity 的标题字段是 primary_name
        const title = entry.title || (typeLabel === 'entity' ? (entry.primary_name || '') : '');
        const titleS = s.t || '';
        const titleSearch = joinFields([title, titleS && titleS !== title ? titleS : null]);

        const author = entry.author || '';
        const authorS = s.a || '';
        const authorSearch = joinFields([author, authorS && authorS !== author ? authorS : null]);

        // additional_titles 可能是字符串或 {book_title} 对象
        const aliases = (entry.additional_titles || [])
            .map(t => typeof t === 'string' ? t : t?.book_title)
            .filter(Boolean);
        const attached = (entry.attached_texts || [])
            .map(t => typeof t === 'string' ? t : t?.book_title)
            .filter(Boolean);
        const aliasesS = (s.at || []);
        const aliasesSearch = joinFields([
            ...aliases,
            ...aliasesS.filter((x, i) => x && x !== aliases[i]),
            ...attached,
        ]);

        docs.push({
            id: entry.id,
            type: typeLabel,
            title_search: titleSearch,
            author_search: authorSearch,
            aliases_search: aliasesSearch,
            // storeFields 透传给 worker hits, 直接渲染卡片不需 hydration
            title,
            author,
            dynasty: entry.dynasty || '',
            role: entry.role,
            edition: entry.edition,
            additional_titles: aliases,
            attached_texts: attached,
            juan_count: entry.juan_count,
            has_text: entry.has_text,
            has_image: entry.has_image,
            has_collated: entry.has_collated,
            subtype: entry.subtype,
            primary_name: entry.primary_name,
            birth_year: entry.birth_year,
            death_year: entry.death_year,
            cbdb_id: entry.cbdb_id,
        });
    }
    return docs;
}

function msOptions() {
    return {
        idField: 'id',
        fields: ['title_search', 'author_search', 'aliases_search'],
        storeFields: [
            'id', 'type', 'title', 'author', 'dynasty', 'role', 'edition',
            'additional_titles', 'attached_texts', 'juan_count',
            'has_text', 'has_image', 'has_collated',
            'subtype', 'primary_name', 'birth_year', 'death_year', 'cbdb_id',
        ],
        tokenize: (text) => tokenize(text),
        processTerm: (term) => term,
    };
}

const WORK_SHARD_COUNT = 4;

function buildIndexForType(index, searchS, groupKey, typeLabel) {
    const docs = buildDocs(index, searchS, groupKey, typeLabel);
    const shardCount = typeLabel === 'work' ? WORK_SHARD_COUNT : 1;
    const chunkSize = Math.ceil(docs.length / shardCount);

    const shardInfos = [];
    let totalBuildMs = 0;
    for (let i = 0; i < shardCount; i++) {
        const chunk = docs.slice(i * chunkSize, (i + 1) * chunkSize);
        if (chunk.length === 0) continue;
        const ms = new MiniSearch(msOptions());
        const t0 = Date.now();
        ms.addAll(chunk);
        const buildMs = Date.now() - t0;
        totalBuildMs += buildMs;
        const json = JSON.stringify(ms);
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

/** 构建搜索专用的繁→简差异表（仅 title/author/additional_titles 与原文不同的条目） */
function buildSearchSimplified(index) {
    const t2s = OpenCC.Converter({ from: 'tw', to: 'cn' });
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
            if (item.additional_titles && item.additional_titles.length > 0) {
                const titles = item.additional_titles
                    .map(t => typeof t === 'string' ? t : t?.book_title)
                    .filter(Boolean);
                const ats = titles.map(t => t2s(t));
                if (ats.some((s, i) => s !== titles[i])) simplified.at = ats;
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
        version: 4,
        fields: ['title_search', 'author_search', 'aliases_search'],
        tokenizer: 'bigram+unigram-fallback',
        indices,
        builtAt: new Date().toISOString(),
    };
    writeJson(join(SEARCH_DIR, 'meta.json'), meta);
    const total = indices.reduce((s, i) => s + i.sizeKb, 0);
    console.log(`SRCH  meta.json written (total ${total} KB across ${indices.length} shards)`);
}

build();
