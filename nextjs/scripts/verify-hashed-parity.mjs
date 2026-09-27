#!/usr/bin/env node
/**
 * verify-hashed-parity.mjs — A3 完成判据 2：抽样比对 h1 路径与现行路径内容是否逐字一致
 *
 * 现行路径的真值 = public/data/entry/<id>.json（bundle-data.mjs 产出）。
 * h1 路径的真值   = public/data-h1/manifest*.json 解出 <id> 的哈希，
 *                  再读 public/data-h1/entry/<id>.<hash8>.json。
 * 两边字节必须完全一致——bundle-hashed.mjs 就是直接从前者复制字节写后者，
 * 这里做的是端到端核验：抽真实样本，证明「设计上应该一致」在磁盘上真的一致，
 * 不是只在单测的 mock 数据上一致。
 *
 * 抽样覆盖四种类型（work/book/collection/entity）；样本量与类型分布可调，
 * 默认每类型最多 5 条、总数不超过 20 条，凑不满 20 条时如实报告实际抽样数。
 *
 * 用法：
 *   node scripts/verify-hashed-parity.mjs
 *   SAMPLE_SIZE=40 node scripts/verify-hashed-parity.mjs
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, '..', 'public', 'data');
const H1_DIR = resolve(__dirname, '..', 'public', 'data-h1');
const ENTRY_SRC_DIR = join(DATA_DIR, 'entry');
const SAMPLE_SIZE = parseInt(process.env.SAMPLE_SIZE || '20', 10);

function fail(msg) {
    console.error(`❌ ${msg}`);
    process.exit(1);
}

if (!existsSync(ENTRY_SRC_DIR)) fail(`${ENTRY_SRC_DIR} 不存在，先跑 bundle-data.mjs`);
if (!existsSync(H1_DIR)) fail(`${H1_DIR} 不存在，先跑 bundle-hashed.mjs`);

// ─── 1. 建 id → hash8（读 manifest 分片，跟 cos-storage.ts 前端走的是同一份产物） ───

function loadManifestMap() {
    const manifestDir = join(H1_DIR, 'manifest');
    const map = new Map();
    for (const fname of readdirSync(manifestDir)) {
        const shard = JSON.parse(readFileSync(join(manifestDir, fname), 'utf-8'));
        for (const [id, hash] of Object.entries(shard)) map.set(id, hash);
    }
    return map;
}

// ─── 2. 按类型分桶抽样（跟前端 extractType 的判法保持独立：这里只按 id 的
//        snowflake type 位粗分，够用于抽样分布，不追求跟 book-index-ui 位对位） ───
//
// type 位在 id 的固定偏移，四种类型的样本文件名本身能在 meta.json 的计数对上就够；
// 更稳妥的办法是直接问 book-index-ui 的 extractType，这里用它，不再自己解码。

async function classify(ids) {
    const { extractType } = await import('book-index-ui');
    const buckets = { work: [], book: [], collection: [], entity: [] };
    for (const id of ids) {
        try {
            const t = extractType(id);
            if (buckets[t]) buckets[t].push(id);
        } catch {
            // 极少数 id 解不出类型，跳过即可，不影响抽样结论
        }
    }
    return buckets;
}

function sampleFrom(buckets, total) {
    const types = Object.keys(buckets);
    const perType = Math.ceil(total / types.length);
    const picked = [];
    for (const t of types) {
        for (const id of buckets[t].slice(0, perType)) picked.push({ id, type: t });
        if (picked.length >= total) break;
    }
    return picked.slice(0, total);
}

async function main() {
    const manifestMap = loadManifestMap();
    const allIds = readdirSync(ENTRY_SRC_DIR).map(f => f.slice(0, -'.json'.length));
    const buckets = await classify(allIds);
    for (const [t, ids] of Object.entries(buckets)) {
        console.log(`  分桶 ${t}: ${ids.length} 条候选`);
    }

    const samples = sampleFrom(buckets, SAMPLE_SIZE);
    if (samples.length === 0) fail('抽不到任何样本，检查 book-index-ui 的 extractType 与 id 是否匹配');

    let matched = 0;
    const mismatches = [];
    for (const { id, type } of samples) {
        const legacyPath = join(ENTRY_SRC_DIR, `${id}.json`);
        const legacyBuf = readFileSync(legacyPath);

        const hash = manifestMap.get(id);
        if (!hash) {
            mismatches.push({ id, type, reason: 'manifest 里找不到这个 id' });
            continue;
        }
        const h1Path = join(H1_DIR, 'entry', `${id}.${hash}.json`);
        if (!existsSync(h1Path)) {
            mismatches.push({ id, type, reason: `h1 entry 文件不存在: ${h1Path}` });
            continue;
        }
        const h1Buf = readFileSync(h1Path);

        if (legacyBuf.equals(h1Buf)) {
            matched++;
        } else {
            mismatches.push({ id, type, reason: `字节不一致（legacy ${legacyBuf.length}B vs h1 ${h1Buf.length}B）` });
        }
    }

    console.log(`\n抽样 ${samples.length} 条（${[...new Set(samples.map(s => s.type))].join('/')}），逐字一致 ${matched}/${samples.length}`);
    for (const { id, type } of samples) {
        const isMismatch = mismatches.some(m => m.id === id);
        console.log(`  ${isMismatch ? '✗' : '✓'} ${type.padEnd(10)} ${id}`);
    }

    if (mismatches.length > 0) {
        console.error(`\n❌ ${mismatches.length} 条不一致：`);
        for (const m of mismatches) console.error(`   ${m.id} (${m.type}): ${m.reason}`);
        process.exit(1);
    }

    console.log(`\n✅ ${matched}/${samples.length} 条内容逐字一致\n`);
}

main();
