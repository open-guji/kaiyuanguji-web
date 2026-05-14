#!/usr/bin/env node
/**
 * sync-to-cos.mjs — 把 bundle-data.mjs 产出的 public/data/ 同步到腾讯云 COS
 *
 * 流程（顺序敏感，不能并行）：
 *   1. 读取 public/data/version.json 拿到 commitId
 *   2. 把 public/data/ 整体上传到 cos://{bucket}/v/{shortCommit}/
 *      - 不可变前缀，每次发布写新目录
 *      - CDN 端可配 1 年长缓存
 *   3. 所有文件传完之后，最后覆盖 cos://{bucket}/latest.json
 *      - 短 TTL（30s），是唯一需要 PURGE 的 URL
 *      - 顺序保证用户永远不会读到「latest 指向但文件还没传完」的状态
 *
 * 环境变量：
 *   COS_SECRET_ID       (必填) 腾讯云 SecretId
 *   COS_SECRET_KEY      (必填) 腾讯云 SecretKey
 *   COS_BUCKET          (必填) 桶名，如 kyg-data-1300xxxxxx
 *   COS_REGION          (可选) 默认 ap-shanghai
 *   COS_PATH_PREFIX     (可选) 桶内根前缀，默认空字符串
 *   DRY_RUN             (可选) 设为 1 只打印不上传
 *
 * 用法：
 *   node scripts/sync-to-cos.mjs              # 上传 public/data → cos
 *   DRY_RUN=1 node scripts/sync-to-cos.mjs    # 干跑
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, resolve, dirname, posix } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// ─── 加载 .env.local（不存在则跳过，CI 里用真实环境变量） ───
//
// 极简 dotenv：只处理 KEY=value，忽略空行 / # 开头。
// 已经存在于 process.env 的优先（避免 .env.local 误覆盖 CI 注入）。
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

// ─── 配置 ───

const DATA_DIR = resolve(__dirname, '..', 'public', 'data');
const LATEST_FILE = resolve(__dirname, '..', 'public', 'latest.json');

const SECRET_ID = process.env.COS_SECRET_ID;
const SECRET_KEY = process.env.COS_SECRET_KEY;
const BUCKET = process.env.COS_BUCKET;
const REGION = process.env.COS_REGION || 'ap-shanghai';
const PATH_PREFIX = (process.env.COS_PATH_PREFIX || '').replace(/^\/+|\/+$/g, '');
const DRY_RUN = process.env.DRY_RUN === '1';

// ─── 校验 ───

if (!existsSync(DATA_DIR)) {
    console.error(`❌ ${DATA_DIR} not found. Run bundle-data.mjs first.`);
    process.exit(1);
}
if (!existsSync(LATEST_FILE)) {
    console.error(`❌ ${LATEST_FILE} not found. Re-run bundle-data.mjs (latest.json now produced alongside version.json).`);
    process.exit(1);
}

const latest = JSON.parse(readFileSync(LATEST_FILE, 'utf-8'));
const shortCommit = latest.commitId;
if (!shortCommit || shortCommit === 'unknown') {
    console.error('❌ latest.json has no usable commitId. Aborting.');
    process.exit(1);
}

if (!DRY_RUN) {
    for (const [name, val] of Object.entries({ COS_SECRET_ID: SECRET_ID, COS_SECRET_KEY: SECRET_KEY, COS_BUCKET: BUCKET })) {
        if (!val) {
            console.error(`❌ Missing env ${name}`);
            process.exit(1);
        }
    }
}

// ─── 收集文件 ───

function walk(dir, base = dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const stat = statSync(full);
        if (stat.isDirectory()) {
            out.push(...walk(full, base));
        } else {
            const relative = full.slice(base.length + 1).split(/[\\/]/).join('/');
            out.push({ full, relative, size: stat.size });
        }
    }
    return out;
}

const files = walk(DATA_DIR);
const totalBytes = files.reduce((s, f) => s + f.size, 0);

function joinKey(...parts) {
    return parts.filter(Boolean).map(p => p.replace(/^\/+|\/+$/g, '')).join('/');
}

const versionPrefix = joinKey(PATH_PREFIX, 'v', shortCommit);
const latestKey = joinKey(PATH_PREFIX, 'latest.json');

console.log(`\nsync-to-cos`);
console.log(`  bucket:   ${BUCKET}`);
console.log(`  region:   ${REGION}`);
console.log(`  source:   ${DATA_DIR}`);
console.log(`  target:   cos://${BUCKET}/${versionPrefix}/`);
console.log(`  latest:   cos://${BUCKET}/${latestKey}  → { commitId: "${shortCommit}" }`);
console.log(`  files:    ${files.length}, total ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
console.log(`  mode:     ${DRY_RUN ? 'DRY RUN' : 'UPLOAD'}\n`);

if (DRY_RUN) {
    console.log('— sample (first 10 files) —');
    for (const f of files.slice(0, 10)) {
        console.log(`  ${versionPrefix}/${f.relative}  (${f.size} B)`);
    }
    console.log('\n(dry run, nothing uploaded)\n');
    process.exit(0);
}

// ─── 上传 ───

let COS;
try {
    COS = require('cos-nodejs-sdk-v5');
} catch {
    console.error('❌ cos-nodejs-sdk-v5 not installed. Run: npm i -D cos-nodejs-sdk-v5');
    process.exit(1);
}

// FileParallelLimit + ChunkParallelLimit 提升整体并发；UserAgent 便于在 COS 访问日志里识别
const cos = new COS({
    SecretId: SECRET_ID,
    SecretKey: SECRET_KEY,
    FileParallelLimit: 80,
    ChunkParallelLimit: 8,
    Timeout: 60 * 1000,
});

function ext(name) {
    const i = name.lastIndexOf('.');
    return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

function contentTypeFor(relative) {
    switch (ext(relative)) {
        case 'json': return 'application/json; charset=utf-8';
        case 'txt':  return 'text/plain; charset=utf-8';
        case 'md':   return 'text/markdown; charset=utf-8';
        case 'png':  return 'image/png';
        case 'jpg':
        case 'jpeg': return 'image/jpeg';
        case 'svg':  return 'image/svg+xml';
        case 'webp': return 'image/webp';
        default:     return 'application/octet-stream';
    }
}

// v/{commit}/ 下都是不可变文件，1 年长缓存
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
// latest.json 是软指针，30 秒
const LATEST_CACHE = 'public, max-age=30, must-revalidate';

// 小文件阈值：低于此走 putObject（轻量单 PUT，零事件循环开销）；
// 高于此走 uploadFile（自动 multipart）。
const SMALL_FILE_THRESHOLD = 5 * 1024 * 1024;  // 5 MB

async function uploadOne({ full, relative, size }, attempt = 1) {
    const key = `${versionPrefix}/${relative}`;
    try {
        if (size <= SMALL_FILE_THRESHOLD) {
            return await new Promise((resolveP, rejectP) => {
                cos.putObject({
                    Bucket: BUCKET,
                    Region: REGION,
                    Key: key,
                    Body: readFileSync(full),
                    ContentType: contentTypeFor(relative),
                    CacheControl: IMMUTABLE_CACHE,
                }, (err) => err ? rejectP(err) : resolveP({ key, size }));
            });
        }
        return await new Promise((resolveP, rejectP) => {
            cos.uploadFile({
                Bucket: BUCKET,
                Region: REGION,
                Key: key,
                FilePath: full,
                ContentType: contentTypeFor(relative),
                CacheControl: IMMUTABLE_CACHE,
                SliceSize: 1024 * 1024 * 10,
                onProgress: () => {},
            }, (err) => err ? rejectP(err) : resolveP({ key, size }));
        });
    } catch (e) {
        const transient = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network/i.test(e.message || '');
        if (transient && attempt < 4) {
            await new Promise(r => setTimeout(r, 500 * 2 ** attempt));
            return uploadOne({ full, relative, size }, attempt + 1);
        }
        throw e;
    }
}

async function uploadLatest() {
    return new Promise((resolveP, rejectP) => {
        cos.putObject({
            Bucket: BUCKET,
            Region: REGION,
            Key: latestKey,
            Body: readFileSync(LATEST_FILE),
            ContentType: 'application/json; charset=utf-8',
            CacheControl: LATEST_CACHE,
        }, (err) => err ? rejectP(err) : resolveP());
    });
}

/**
 * List 当前 versionPrefix 下已存在的对象 key —— 用于跳过已上传文件，
 * 实现增量 sync（断点续传 / 同 commit 重试零浪费）。
 *
 * 仅按 key 存在性判断，不比对 ETag/MD5：v/{commit}/* 路径设计上不可变，
 * 同一 commit 下同一 key 内容也相同（除非 bundle 逻辑变了，那种情况需要换 commit）。
 */
async function listExistingKeys() {
    const existing = new Set();
    let marker = '';
    let pages = 0;
    while (true) {
        const res = await new Promise((resolveP, rejectP) => {
            cos.getBucket({
                Bucket: BUCKET, Region: REGION,
                Prefix: versionPrefix + '/',
                Marker: marker,
                MaxKeys: 1000,
            }, (err, data) => err ? rejectP(err) : resolveP(data));
        });
        for (const obj of res.Contents || []) existing.add(obj.Key);
        pages++;
        if (res.IsTruncated === 'true' || res.IsTruncated === true) {
            marker = res.NextMarker || res.Contents[res.Contents.length - 1].Key;
        } else {
            break;
        }
    }
    return { existing, pages };
}

async function main() {
    // 80 并发 + putObject 小文件路径：实测 14 files/s → 目标 100+ files/s
    const CONCURRENCY = 80;

    // 增量 sync：扫已存在 key，跳过已传文件
    console.log(`  listing existing keys at v/${shortCommit}/...`);
    const tList = Date.now();
    const { existing, pages } = await listExistingKeys();
    console.log(`  found ${existing.size} existing keys (${pages} list pages, ${((Date.now() - tList) / 1000).toFixed(1)}s)`);

    const toUpload = files.filter(f => !existing.has(`${versionPrefix}/${f.relative}`));
    const skipped = files.length - toUpload.length;
    const toUploadBytes = toUpload.reduce((s, f) => s + f.size, 0);
    console.log(`  skip ${skipped} already-uploaded · upload ${toUpload.length} new (${(toUploadBytes / 1024 / 1024).toFixed(1)} MB)`);

    if (toUpload.length === 0) {
        console.log(`  ✓ all files already on COS for this commit`);
    } else {
        const queue = [...toUpload];
        let done = 0;
        let uploadedBytes = 0;
        const failures = [];
        const t0 = Date.now();

        async function worker() {
            while (queue.length > 0) {
                const f = queue.shift();
                if (!f) return;
                try {
                    await uploadOne(f);
                    done++;
                    uploadedBytes += f.size;
                    if (done % 100 === 0 || done === toUpload.length) {
                        const pct = ((done / toUpload.length) * 100).toFixed(1);
                        const mb = (uploadedBytes / 1024 / 1024).toFixed(1);
                        const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
                        process.stdout.write(`\r  uploading: ${done}/${toUpload.length} (${pct}%, ${mb} MB, ${elapsed}s)   `);
                    }
                } catch (e) {
                    failures.push({ file: f.relative, err: e.message });
                    console.error(`\n  ⚠ failed: ${f.relative} — ${e.message}`);
                }
            }
        }

        await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
        process.stdout.write('\n');

        if (failures.length > 0) {
            console.error(`\n❌ ${failures.length} file(s) failed. NOT updating latest.json. Re-run to retry (already-uploaded will be skipped).`);
            process.exit(2);
        }

        console.log(`  ✓ uploaded ${done} files (${(uploadedBytes / 1024 / 1024).toFixed(1)} MB) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }

    console.log(`\n  writing latest.json → cos://${BUCKET}/${latestKey}`);
    await uploadLatest();
    console.log(`  ✓ latest.json now points to v/${shortCommit}/`);

    console.log(`\n✅ sync-to-cos complete\n`);
}

main().catch(err => {
    console.error(`\n❌ Fatal: ${err.message}`);
    process.exit(1);
});
