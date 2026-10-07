#!/usr/bin/env node
/**
 * verify-hashed-text-parity.mjs — A3b 完成判据 1：抽样比对 h1 阅读文本
 * 路径与现行 items/ 路径内容是否逐字一致
 *
 * 现行路径的真值 = public/data/items/<owner_id>/<relPath>（bundle-data.mjs 产出，
 * 前端经 book-index-ui 的 BundleStorage 读取）。
 * h1 路径的真值   = public/data-h1-text/text-manifest*.json 解出
 *                  <owner_id>/<relPath> 的哈希，再读
 *                  public/data-h1-text/text/<owner_id>/<relPath 插入哈希>。
 * 两边字节必须完全一致——bundle-hashed-text.mjs 就是直接从前者复制字节写后者，
 * 这里做端到端核验：抽真实样本（manifest、章目录、章文本），证明
 * 「设计上应该一致」在磁盘上真的一致，不是只在单测的 mock 数据上一致。
 *
 * 用法：
 *   node scripts/verify-hashed-text-parity.mjs
 *   SAMPLE_SIZE=40 node scripts/verify-hashed-text-parity.mjs
 *   SAMPLE_SEED=<整数> SAMPLE_SIZE=200 node scripts/verify-hashed-text-parity.mjs   # 等距抽样的起点按种子偏移（不设＝从 0 起）
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join, dirname, extname, basename } from 'path';
import { resolveDataDirs } from './lib/data-dirs.mjs';
import { publicKeys, readManifest } from './lib/text-layout.mjs';

const { dataDir: DATA_DIR, h1TextDir: H1_TEXT_DIR } = resolveDataDirs();
const ITEMS_SRC_DIR = join(DATA_DIR, 'items');
const SAMPLE_SIZE = parseInt(process.env.SAMPLE_SIZE || '20', 10);
// SAMPLE_SEED（可选）：等距抽样的起点偏移＝种子对候选池大小取余（循环，尾部也能被覆盖）。CI 里每次传不同的种子（run id），覆盖面随部署次数累积；不设＝从 0 起，结果固定
const SAMPLE_SEED = Number.isFinite(parseInt(process.env.SAMPLE_SEED, 10)) ? parseInt(process.env.SAMPLE_SEED, 10) : null;

function fail(msg) {
    console.error(`❌ ${msg}`);
    process.exit(1);
}

if (!existsSync(ITEMS_SRC_DIR)) fail(`${ITEMS_SRC_DIR} 不存在，先跑 bundle-data.mjs`);
if (!existsSync(H1_TEXT_DIR)) fail(`${H1_TEXT_DIR} 不存在，先跑 bundle-hashed-text.mjs`);

// 与 cos-storage.ts 的 insertH1TextHash / bundle-hashed-text.mjs 的 insertHash
// 是同一套算法：relPath 最后一段插入哈希。三处各自小巧独立实现（无副作用的
// 纯函数），这里第三次实现是为了核验前两处「各自实现是否吻合」，故意不 import
// 复用——复用了就只是同一份代码抄三遍再抄一份，测不出「两边对不对」。
function insertHash(relPath, hash) {
    const dir = dirname(relPath);
    const base = basename(relPath);
    const ext = extname(base);
    const stem = ext ? base.slice(0, -ext.length) : base;
    const hashedBase = ext ? `${stem}.${hash}${ext}` : `${stem}.${hash}`;
    return dir === '.' ? hashedBase : `${dir}/${hashedBase}`;
}

function loadTextManifestMap() {
    const manifestDir = join(H1_TEXT_DIR, 'text-manifest');
    // map: `${ownerId}/${relPath}` -> hash8
    const map = new Map();
    for (const fname of readdirSync(manifestDir)) {
        const shard = JSON.parse(readFileSync(join(manifestDir, fname), 'utf-8'));
        for (const [ownerId, relMap] of Object.entries(shard)) {
            for (const [relPath, hash] of Object.entries(relMap)) {
                map.set(`${ownerId}/${relPath}`, hash);
            }
        }
    }
    return map;
}

/** 抽样候选：{ ownerId, relPath, kind }，kind 是文本的类别（manifest／按 default 版本的 kind 与条目类型分桶） */
async function collectCandidates() {
    const candidates = { 文本: [] };

    for (const ownerId of readdirSync(ITEMS_SRC_DIR)) {
        const ownerDir = join(ITEMS_SRC_DIR, ownerId);
        if (!statSync(ownerDir).isDirectory()) continue;
        // manifest.json 与公开版本目录，与 bundle-hashed-text 同一范围（overview#307）
        if (readManifest(ownerDir)) {
            candidates['文本'].push({ ownerId, relPath: 'manifest.json' });
            for (const key of publicKeys(ownerDir)) {
                const keyDir = join(ownerDir, key);
                if (existsSync(keyDir) && statSync(keyDir).isDirectory()) {
                    for (const f of walkRel(keyDir, ownerDir)) candidates['文本'].push({ ownerId, relPath: f });
                }
            }
        }
    }
    return candidates;
}

function walkRel(dir, base) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
            out.push(...walkRel(full, base));
        } else {
            out.push(full.slice(base.length + 1).split(/[\\/]/).join('/'));
        }
    }
    return out;
}

function sampleFrom(candidates, total) {
    const kinds = Object.keys(candidates);
    const perKind = Math.ceil(total / kinds.length);
    const picked = [];
    for (const kind of kinds) {
        const pool = candidates[kind];
        // 等距抽样：n 个点均匀铺满整个候选池（含尾部），起点按种子在池内循环偏移（负种子也归一到非负），索引互不重复
        const n = Math.min(perKind, pool.length);
        const start = SAMPLE_SEED === null ? 0 : ((SAMPLE_SEED % pool.length) + pool.length) % pool.length;
        for (let k = 0; k < n; k++) {
            picked.push({ ...pool[(start + Math.floor((k * pool.length) / n)) % pool.length], kind });
        }
    }
    return picked.slice(0, total);
}

async function main() {
    const manifestMap = loadTextManifestMap();
    const candidates = await collectCandidates();
    for (const [kind, list] of Object.entries(candidates)) {
        console.log(`  分桶 ${kind}: ${list.length} 份候选`);
    }

    const samples = sampleFrom(candidates, SAMPLE_SIZE);
    if (samples.length === 0) fail('抽不到任何样本，检查 public/data/items 下是否有 manifest.json');

    let matched = 0;
    const mismatches = [];
    for (const { ownerId, relPath, kind } of samples) {
        const srcPath = join(ITEMS_SRC_DIR, ownerId, relPath);
        const srcBuf = readFileSync(srcPath);

        const key = `${ownerId}/${relPath}`;
        const hash = manifestMap.get(key);
        if (!hash) {
            mismatches.push({ key, kind, reason: 'text-manifest 里找不到这个 owner/相对路径' });
            continue;
        }
        const h1Path = join(H1_TEXT_DIR, 'text', ownerId, insertHash(relPath, hash));
        if (!existsSync(h1Path)) {
            mismatches.push({ key, kind, reason: `h1 text 文件不存在: ${h1Path}` });
            continue;
        }
        const h1Buf = readFileSync(h1Path);

        if (srcBuf.equals(h1Buf)) {
            matched++;
        } else {
            mismatches.push({ key, kind, reason: `字节不一致（items ${srcBuf.length}B vs h1 ${h1Buf.length}B）` });
        }
    }

    console.log(`\n抽样 ${samples.length} 份（${[...new Set(samples.map(s => s.kind))].join('/')}），逐字一致 ${matched}/${samples.length}`);
    for (const { ownerId, relPath, kind } of samples) {
        const key = `${ownerId}/${relPath}`;
        const isMismatch = mismatches.some(m => m.key === key);
        console.log(`  ${isMismatch ? '✗' : '✓'} ${kind.padEnd(8)} ${ownerId}/${relPath}`);
    }

    if (mismatches.length > 0) {
        console.error(`\n❌ ${mismatches.length} 份不一致：`);
        for (const m of mismatches) console.error(`   ${m.key} (${m.kind}): ${m.reason}`);
        process.exit(1);
    }

    console.log(`\n✅ ${matched}/${samples.length} 份内容逐字一致\n`);
}

main();
