#!/usr/bin/env node
/**
 * smoke-search.mjs — Node 端复现 Worker 查询路径，快速验证索引可用性与体积。
 */

import { readFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import MiniSearch from 'minisearch';
import { tokenize, hasCjkBigram } from '../src/lib/search/normalize.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEARCH_DIR = resolve(__dirname, '..', 'public', 'data', 'search');

const msOptions = {
    idField: 'id',
    fields: ['title_search', 'author_search'],
    storeFields: ['id', 'type', 'title', 'author', 'dynasty'],
    tokenize: (text) => tokenize(text),
    processTerm: (term) => term,
};

// ─── 加载（处理 shards） ───

const meta = JSON.parse(readFileSync(join(SEARCH_DIR, 'meta.json'), 'utf-8'));

const engines = new Map(); // type → MiniSearch[]
let totalLoad = 0;
let totalParse = 0;
for (const idx of meta.indices) {
    const files = idx.shards ?? (idx.file ? [idx.file] : []);
    const shards = [];
    for (const f of files) {
        const t0 = Date.now();
        const text = readFileSync(join(SEARCH_DIR, f), 'utf-8');
        totalLoad += Date.now() - t0;
        const t1 = Date.now();
        shards.push(MiniSearch.loadJSON(text, msOptions));
        totalParse += Date.now() - t1;
        const sizeMb = (Buffer.byteLength(text) / 1024 / 1024).toFixed(2);
        console.log(`loaded ${idx.type}/${f}: ${sizeMb} MB`);
    }
    engines.set(idx.type, shards);
    console.log(`  → ${idx.type}: ${files.length} shard(s), ${idx.docCount} docs total`);
}
console.log(`\ntotal load: ${totalLoad} ms, total parse: ${totalParse} ms  (Node 顺序; 浏览器 Worker 所有分片并行，parse ≈ max shard)\n`);

// ─── 查询 ───

function searchAllShards(shards, q) {
    const len = Array.from(q).filter(c => /\S/.test(c)).length;
    const enableFuzzy = len >= 3;
    const qTokens = tokenize(q);
    const prefixForStrict = !hasCjkBigram(qTokens);

    const strictAll = [];
    for (const engine of shards) {
        const hits = engine.search(q, {
            combineWith: 'AND',
            prefix: prefixForStrict,
            fuzzy: enableFuzzy ? 0.2 : false,
        });
        strictAll.push(...hits);
    }
    if (strictAll.length > 0) {
        strictAll.sort((a, b) => b.score - a.score);
        return { mode: prefixForStrict ? 'AND+prefix' : 'AND', results: strictAll };
    }

    const bigrams = [...new Set(qTokens.filter(t => Array.from(t).length >= 2))];
    if (bigrams.length < 2) return { mode: 'AND', results: [] };

    const statsMap = new Map();
    for (const bg of bigrams) {
        for (const engine of shards) {
            const hits = engine.search(bg, { combineWith: 'AND', prefix: false, fuzzy: false });
            for (const h of hits) {
                const prev = statsMap.get(h.id);
                if (prev) { prev.hits++; prev.score += h.score; }
                else statsMap.set(h.id, { hits: 1, score: h.score, doc: h });
            }
        }
    }
    const all = [...statsMap.values()];
    const startMin = Math.max(1, Math.ceil(bigrams.length / 2));
    for (let m = startMin; m >= 1; m--) {
        const layer = all.filter(s => s.hits >= m);
        if (layer.length > 0) {
            layer.sort((a, b) => (b.hits - a.hits) || (b.score - a.score));
            return { mode: `MSM${m}/${bigrams.length}`, results: layer.map(s => s.doc) };
        }
    }
    return { mode: `MSM0/${bigrams.length}`, results: [] };
}

function search(q) {
    const workShards = engines.get('work');
    return searchAllShards(workShards, q);
}

const queries = [
    '孟子',
    '孟子梁惠王',
    '孟子梁惠',
    '孟的子',
    '說文',
    '说文',
    '史記',
    '史记',
    '司马迁',
    '紀昀',
    '纪昀',
    '淮南子',
    '易',           // 单字查询（1字标题也能命中）
    '孟',           // 单字查询（应 prefix 展开）
    '不存在的奇怪书名xyz',
];

for (const q of queries) {
    const t = Date.now();
    const { mode, results } = search(q);
    const dt = Date.now() - t;
    const top = results.slice(0, 3).map(r => `${r.type}:${r.title}/${r.author || '-'}`);
    console.log(`q="${q}"  [${mode}] (${dt}ms, ${results.length} hits)  top3: ${top.join(' | ') || '(none)'}`);
}
