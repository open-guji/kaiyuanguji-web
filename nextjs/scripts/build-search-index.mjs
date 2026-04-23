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

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import MiniSearch from 'minisearch';
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

        const title = entry.title || '';
        const titleS = s.t || '';
        const titleSearch = joinFields([title, titleS && titleS !== title ? titleS : null]);

        const author = entry.author || '';
        const authorS = s.a || '';
        const authorSearch = joinFields([author, authorS && authorS !== author ? authorS : null]);

        docs.push({
            id: entry.id,
            type: typeLabel,
            title_search: titleSearch,
            author_search: authorSearch,
            dynasty: entry.dynasty || '',
            title,
            author,
        });
    }
    return docs;
}

function msOptions() {
    return {
        idField: 'id',
        fields: ['title_search', 'author_search'],
        storeFields: ['id', 'type', 'title', 'author', 'dynasty'],
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

function build() {
    const indexPath = join(OUT_DIR, 'index.json');
    const searchSPath = join(OUT_DIR, 'search_s.json');

    if (!existsSync(indexPath)) {
        console.error(`❌ ${indexPath} not found. Run bundle-data.mjs first.`);
        process.exit(1);
    }

    const index = readJson(indexPath);
    const searchS = existsSync(searchSPath) ? readJson(searchSPath) : {};

    const shards = [
        ['works', 'work'],
        ['books', 'book'],
        ['collections', 'collection'],
    ];
    const indices = shards.map(([gk, tl]) => buildIndexForType(index, searchS, gk, tl));

    const meta = {
        version: 3,
        fields: ['title_search', 'author_search'],
        tokenizer: 'bigram+unigram-fallback',
        indices,
        builtAt: new Date().toISOString(),
    };
    writeJson(join(SEARCH_DIR, 'meta.json'), meta);
    const total = indices.reduce((s, i) => s + i.sizeKb, 0);
    console.log(`SRCH  meta.json written (total ${total} KB across ${indices.length} shards)`);
}

build();
