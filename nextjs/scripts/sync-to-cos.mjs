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
import { createHash } from 'crypto';

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
 * List 一个 prefix 下所有对象的 key + etag —— 用于增量 sync。
 *
 * 用法：
 *   1. 当前 versionPrefix：判断哪些 key 已经传过（断点续传）
 *   2. 上一个 commit 的 versionPrefix：判断哪些 key 内容跟本地一样（→ copy-object）
 *
 * ETag 对单 PUT 对象 = `"hex_md5"`（带双引号）。multipart 上传会变格式，
 * 但 sync-to-cos.mjs 对小文件走 putObject（单 PUT），ETag 即文件 MD5。
 */
async function listPrefixEtags(prefix) {
    const map = new Map();  // relativeKey → md5 hex (no quotes)
    let marker = '';
    let pages = 0;
    const stripQuotes = (s) => (s || '').replace(/^"|"$/g, '');
    while (true) {
        const res = await new Promise((resolveP, rejectP) => {
            cos.getBucket({
                Bucket: BUCKET, Region: REGION,
                Prefix: prefix,
                Marker: marker,
                MaxKeys: 1000,
            }, (err, data) => err ? rejectP(err) : resolveP(data));
        });
        for (const obj of res.Contents || []) {
            const rel = obj.Key.slice(prefix.length);
            map.set(rel, stripQuotes(obj.ETag));
        }
        pages++;
        if (res.IsTruncated === 'true' || res.IsTruncated === true) {
            marker = res.NextMarker || res.Contents[res.Contents.length - 1].Key;
        } else {
            break;
        }
    }
    return { map, pages };
}

/** 读取 cos://bucket/latest.json 的 commitId，无 → null（首次发布） */
async function getPreviousCommitId() {
    try {
        const res = await new Promise((resolveP, rejectP) => {
            cos.getObject({ Bucket: BUCKET, Region: REGION, Key: latestKey },
                (err, data) => err ? rejectP(err) : resolveP(data));
        });
        const body = JSON.parse(res.Body.toString('utf-8'));
        return body.commitId || null;
    } catch {
        return null;
    }
}

/** 本地 MD5（hex）。文件 < 10 MB 一次读完，>= 10 MB 流式（极少触发）。 */
function md5OfFile(path, size) {
    const hash = createHash('md5');
    hash.update(readFileSync(path));
    return hash.digest('hex');
}

/** COS 服务端 copy-object —— 不走带宽，按 PUT 计费。 */
async function copyOne(srcKey, destKey, attempt = 1) {
    try {
        return await new Promise((resolveP, rejectP) => {
            cos.putObjectCopy({
                Bucket: BUCKET, Region: REGION,
                Key: destKey,
                CopySource: `${BUCKET}.cos.${REGION}.myqcloud.com/${srcKey}`,
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
    // 80 并发 + putObject 小文件路径：实测 14 files/s → 目标 100+ files/s
    const CONCURRENCY = 80;

    // 1) 当前 commit 已上传哪些 → 跳过（断点续传 / 重试零浪费）
    console.log(`  listing existing keys at v/${shortCommit}/...`);
    let tList = Date.now();
    const cur = await listPrefixEtags(versionPrefix + '/');
    console.log(`  found ${cur.map.size} existing keys (${cur.pages} pages, ${((Date.now() - tList) / 1000).toFixed(1)}s)`);

    // 2) 上一个 commit 的 key+etag → 用作 copy-object 复用源
    const prevCommit = await getPreviousCommitId();
    let prevPrefix = null;
    let prevEtags = new Map();
    if (prevCommit && prevCommit !== shortCommit) {
        prevPrefix = joinKey(PATH_PREFIX, 'v', prevCommit);
        console.log(`  prev commit = v/${prevCommit}/ → listing for copy-object reuse...`);
        tList = Date.now();
        const prev = await listPrefixEtags(prevPrefix + '/');
        prevEtags = prev.map;
        console.log(`  prev has ${prevEtags.size} keys (${prev.pages} pages, ${((Date.now() - tList) / 1000).toFixed(1)}s)`);
    }

    // 3) 计算本地 MD5 + 分流：already-uploaded / copy-from-prev / fresh-upload
    console.log(`  computing local MD5s for ${files.length} files...`);
    const tHash = Date.now();
    const toCopy = [];   // { srcKey, destKey, size }
    const toUpload = []; // file
    let alreadyDone = 0;
    for (const f of files) {
        const destKey = `${versionPrefix}/${f.relative}`;
        const localEtag = cur.map.get(f.relative);
        if (localEtag) { alreadyDone++; continue; }  // 已传过 → 跳
        const localMd5 = md5OfFile(f.full, f.size);
        const prevEtag = prevEtags.get(f.relative);
        if (prevEtag && prevEtag === localMd5) {
            toCopy.push({ srcKey: `${prevPrefix}/${f.relative}`, destKey, size: f.size });
        } else {
            toUpload.push(f);
        }
    }
    const toCopyBytes = toCopy.reduce((s, f) => s + f.size, 0);
    const toUploadBytes = toUpload.reduce((s, f) => s + f.size, 0);
    console.log(`  hashed ${files.length} files in ${((Date.now() - tHash) / 1000).toFixed(1)}s`);
    console.log(`  plan: ${alreadyDone} already · ${toCopy.length} copy-from-prev (${(toCopyBytes / 1024 / 1024).toFixed(1)} MB) · ${toUpload.length} upload (${(toUploadBytes / 1024 / 1024).toFixed(1)} MB)`);

    const failures = [];

    // 4) 并发 copy-object（server-side，不走带宽）
    if (toCopy.length > 0) {
        const queue = [...toCopy];
        let done = 0;
        const t0 = Date.now();
        async function copyWorker() {
            while (queue.length > 0) {
                const c = queue.shift();
                if (!c) return;
                try {
                    await copyOne(c.srcKey, c.destKey);
                    done++;
                    if (done % 500 === 0 || done === toCopy.length) {
                        const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
                        process.stdout.write(`\r  copying: ${done}/${toCopy.length} (${elapsed}s)   `);
                    }
                } catch (e) {
                    failures.push({ file: c.destKey, err: 'copy: ' + e.message });
                    console.error(`\n  ⚠ copy failed: ${c.destKey} — ${e.message}`);
                }
            }
        }
        await Promise.all(Array.from({ length: CONCURRENCY }, () => copyWorker()));
        process.stdout.write('\n');
        console.log(`  ✓ copied ${done} files in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }

    // 5) 并发 upload（带宽路径）
    if (toUpload.length > 0) {
        const queue = [...toUpload];
        let done = 0;
        let uploadedBytes = 0;
        const t0 = Date.now();
        async function uploadWorker() {
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
        await Promise.all(Array.from({ length: CONCURRENCY }, () => uploadWorker()));
        process.stdout.write('\n');
        console.log(`  ✓ uploaded ${done} files (${(uploadedBytes / 1024 / 1024).toFixed(1)} MB) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }

    if (failures.length > 0) {
        console.error(`\n❌ ${failures.length} op(s) failed. NOT updating latest.json. Re-run to retry (already-done will be skipped).`);
        process.exit(2);
    }

    if (toCopy.length === 0 && toUpload.length === 0) {
        console.log(`  ✓ all files already on COS for this commit`);
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
