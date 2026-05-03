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
    return { type: typeLabel, file: shardInfos[0].file, docCount: totalDocs, sizeKb: totalSizeKb, buildMs: totalBuildMs };
}

// ─── 主流程 ───

/**
 * 直接从 book-index-draft 的 16 个 shard + collections.json 重建索引；
 * 不再依赖 public/data/index.json（已废弃）。
 */
function loadShardedIndex() {
    const draftDir = process.env.BOOK_INDEX_DRAFT_DIR
        || resolve(__dirname, '..', '..', '..', 'book-index-draft');
    const indexDir = join(draftDir, 'index');
    if (!existsSync(indexDir)) {
        console.error(`❌ index directory not found: ${indexDir}`);
        process.exit(1);
    }
    const merged = { books: {}, collections: {}, works: {}, entities: {} };
    for (const sub of ['books', 'works', 'entities']) {
        const subDir = join(indexDir, sub);
        if (!existsSync(subDir)) continue;
        for (const f of readdirSync(subDir)) {
            if (!f.endsWith('.json')) continue;
            const data = readJson(join(subDir, f));
            Object.assign(merged[sub], data);
        }
    }
    const cf = join(indexDir, 'collections.json');
    if (existsSync(cf)) merged.collections = readJson(cf);
    return merged;
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
