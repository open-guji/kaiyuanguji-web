#!/usr/bin/env node
/**
 * migrate-cos-to-current.mjs — 一次性迁移：把 cos://bucket/v/<commit>/* 复制到
 * cos://bucket/current/*（除 search/ 子目录）+ 同时建立本地 .sync-state.json。
 *
 * 触发场景：sync-to-cos 改造为 current/ 单副本 + v/<commit>/search/ 后，需要把
 * 当前 latest commit 的全部 data 文件搬到 current/，以便后续 sync 增量识别。
 * server-side copyObject 不走带宽。
 *
 * 用法：
 *   node scripts/migrate-cos-to-current.mjs
 *
 * 退出码：0 成功，2 部分失败，1 致命错误。
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// 加载 .env.local
const envLocal = resolve(__dirname, '..', '.env.local');
if (existsSync(envLocal)) {
    for (const line of readFileSync(envLocal, 'utf-8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (!m || line.trim().startsWith('#')) continue;
        const [, k, vRaw] = m;
        const v = vRaw.replace(/^['"]|['"]$/g, '');
        if (!(k in process.env)) process.env[k] = v;
    }
}

const SECRET_ID = process.env.COS_SECRET_ID;
const SECRET_KEY = process.env.COS_SECRET_KEY;
const BUCKET = process.env.COS_BUCKET;
const REGION = process.env.COS_REGION || 'ap-shanghai';
const PATH_PREFIX = (process.env.COS_PATH_PREFIX || '').replace(/^\/+|\/+$/g, '');

for (const [name, val] of Object.entries({ COS_SECRET_ID: SECRET_ID, COS_SECRET_KEY: SECRET_KEY, COS_BUCKET: BUCKET })) {
    if (!val) { console.error(`❌ Missing env ${name}`); process.exit(1); }
}

const COS = require('cos-nodejs-sdk-v5');
const cos = new COS({
    SecretId: SECRET_ID, SecretKey: SECRET_KEY,
    FileParallelLimit: 80, ChunkParallelLimit: 8, Timeout: 60 * 1000,
});

function joinKey(...parts) {
    return parts.filter(Boolean).map(p => p.replace(/^\/+|\/+$/g, '')).join('/');
}

const latestKey = joinKey(PATH_PREFIX, 'latest.json');
const SYNC_STATE_FILE = resolve(__dirname, '..', '.next', '.sync-state.json');

async function getLatestCommit() {
    const res = await new Promise((resolveP, rejectP) => {
        cos.getObject({ Bucket: BUCKET, Region: REGION, Key: latestKey },
            (err, data) => err ? rejectP(err) : resolveP(data));
    });
    return JSON.parse(res.Body.toString('utf-8')).commitId;
}

async function listPrefix(prefix) {
    const map = new Map();
    let marker = '';
    let pages = 0;
    const stripQuotes = (s) => (s || '').replace(/^"|"$/g, '');
    while (true) {
        const res = await new Promise((resolveP, rejectP) => {
            cos.getBucket({ Bucket: BUCKET, Region: REGION, Prefix: prefix, Marker: marker, MaxKeys: 1000 },
                (err, data) => err ? rejectP(err) : resolveP(data));
        });
        for (const obj of res.Contents || []) {
            map.set(obj.Key.slice(prefix.length), stripQuotes(obj.ETag));
        }
        pages++;
        if (res.IsTruncated === 'true' || res.IsTruncated === true) {
            marker = res.NextMarker || res.Contents[res.Contents.length - 1].Key;
        } else break;
    }
    return { map, pages };
}

async function copyOne(srcKey, destKey, attempt = 1) {
    try {
        await new Promise((resolveP, rejectP) => {
            cos.putObjectCopy({
                Bucket: BUCKET, Region: REGION, Key: destKey,
                CopySource: `${BUCKET}.cos.${REGION}.myqcloud.com/${encodeURI(srcKey)}`,
            }, (err) => err ? rejectP(err) : resolveP());
        });
    } catch (e) {
        const transient = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network/i.test(e.message || '');
        if (transient && attempt < 4) {
            await new Promise(r => setTimeout(r, 500 * 2 ** attempt));
            return copyOne(srcKey, destKey, attempt + 1);
        }
        throw e;
    }
}

async function main() {
    const commit = await getLatestCommit();
    if (!commit) { console.error('❌ latest.json missing commitId'); process.exit(1); }
    const srcPrefix = joinKey(PATH_PREFIX, 'v', commit) + '/';
    const dstPrefix = joinKey(PATH_PREFIX, 'current') + '/';
    console.log(`\nmigrate-cos-to-current`);
    console.log(`  src:  cos://${BUCKET}/${srcPrefix}`);
    console.log(`  dst:  cos://${BUCKET}/${dstPrefix}`);
    console.log(`  (search/ is excluded — stays at v/<commit>/search/)\n`);

    console.log(`  listing src...`);
    const tList = Date.now();
    const { map: srcMap, pages } = await listPrefix(srcPrefix);
    console.log(`  found ${srcMap.size} keys in ${pages} pages (${((Date.now() - tList)/1000).toFixed(1)}s)`);

    // 过滤 search/，那是 commit-isolated 保留
    const toCopy = [];
    const skipped = [];
    for (const [rel, etag] of srcMap) {
        if (rel.split('/')[0] === 'search') { skipped.push(rel); continue; }
        toCopy.push({ rel, etag });
    }
    console.log(`  plan: ${toCopy.length} copy · ${skipped.length} skip (search/)`);

    const CONCURRENCY = 80;
    const queue = [...toCopy];
    let done = 0;
    const failures = [];
    const t0 = Date.now();
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
        while (queue.length > 0) {
            const it = queue.shift();
            if (!it) return;
            try {
                await copyOne(srcPrefix + it.rel, dstPrefix + it.rel);
                done++;
                if (done % 500 === 0 || done === toCopy.length) {
                    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
                    process.stdout.write(`\r  copying: ${done}/${toCopy.length} (${elapsed}s)   `);
                }
            } catch (e) {
                failures.push({ rel: it.rel, err: e.message });
                console.error(`\n  ⚠ ${it.rel}: ${e.message}`);
            }
        }
    });
    await Promise.all(workers);
    process.stdout.write('\n');
    console.log(`  ✓ copied ${done}/${toCopy.length} in ${((Date.now() - t0)/1000).toFixed(1)}s`);

    if (failures.length > 0) {
        console.error(`\n❌ ${failures.length} copy(s) failed`);
        process.exit(2);
    }

    // 写本地 sync-state（让后续 sync 不再 ListBucket）
    const stateMap = new Map();
    for (const { rel, etag } of toCopy) stateMap.set(rel, etag);
    mkdirSync(dirname(SYNC_STATE_FILE), { recursive: true });
    writeFileSync(SYNC_STATE_FILE, JSON.stringify({
        version: 2,
        savedAt: new Date().toISOString(),
        files: Object.fromEntries(stateMap),
    }), 'utf-8');
    console.log(`  ✓ wrote .next/.sync-state.json (${stateMap.size} keys)`);

    console.log(`\n✅ migration complete\n`);
}

main().catch(e => { console.error('\n❌ Fatal:', e.message); process.exit(1); });
