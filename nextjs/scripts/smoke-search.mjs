#!/usr/bin/env node
/**
 * smoke-search.mjs — Node 端复现 Worker 的 L2 查询路径（轻量分片，见 src/lib/search/lite.js），
 * 快速验证分片可用性、体积与单次扫描耗时。先跑 build-search-index.mjs。
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { resolveDataDirs } from './lib/data-dirs.mjs';
import { LITE_FORMAT, decodeLiteRows, liteSearch } from '../src/lib/search/lite.js';

const SEARCH_DIR = join(resolveDataDirs().dataDir, 'search');

// ─── 加载（处理 shards） ───

const meta = JSON.parse(readFileSync(join(SEARCH_DIR, 'meta.json'), 'utf-8'));
if (meta.format !== LITE_FORMAT) {
    console.error(`❌ meta.json 不是轻量格式（format=${meta.format}）——先用新版 build-search-index.mjs 重建`);
    process.exit(1);
}

const docsByType = new Map(); // type → LiteDoc[]
let totalBytes = 0;
const t0 = Date.now();
for (const idx of meta.indices) {
    const files = idx.shards ?? (idx.file ? [idx.file] : []);
    const docs = [];
    for (const f of files) {
        const text = readFileSync(join(SEARCH_DIR, f), 'utf-8');
        totalBytes += Buffer.byteLength(text);
        docs.push(...decodeLiteRows(JSON.parse(text), idx.type));
        console.log(`loaded ${idx.type}/${f}: ${(Buffer.byteLength(text) / 1024 / 1024).toFixed(2)} MB`);
    }
    docsByType.set(idx.type, docs);
    console.log(`  → ${idx.type}: ${files.length} shard(s), ${docs.length} docs`);
}
console.log(`\ntotal ${(totalBytes / 1024 / 1024).toFixed(2)} MB, load+decode ${Date.now() - t0} ms\n`);

// ─── 查询 ───

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
    const results = [...docsByType.values()].flatMap(docs => liteSearch(docs, q));
    const dt = Date.now() - t;
    const top = results.slice(0, 3).map(({ doc }) => `${doc.type}:${doc.title}/${doc.author || '-'}`);
    console.log(`q="${q}"  (${dt}ms, ${results.length} hits)  top3: ${top.join(' | ') || '(none)'}`);
}
