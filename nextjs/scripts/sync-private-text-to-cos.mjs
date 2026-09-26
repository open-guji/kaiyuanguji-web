#!/usr/bin/env node
/**
 * sync-private-text-to-cos.mjs — 把私有仓 open-guji-core/book-text-private
 * 同步到 COS 桶的**私有前缀**（P1-私有文本后端）。
 *
 * 与 sync-to-cos.mjs（公开数据）刻意分开、互不相干：
 *   - 目标前缀不同：`${PRIVATE_COS_PREFIX}/*`（默认 private/book-text-private），
 *     不进公开的 current/、v/、h1/、search、sitemap 任何一条路径。
 *   - 每个对象显式打 `ACL: private`——桶的默认 ACL 是公开读（供 CDN 用），这里必须
 *     逐对象覆盖，否则「进了私有前缀」不等于「真的读不到」。
 *   - 读取只走 edge-functions/api/private-text（服务端签名代理，角色 internal/admin），
 *     不经 CDN、不进 sync-to-cos.mjs 打的公开包。
 *
 * 增量算法：list 当前私有前缀下所有对象的 ETag（= md5，单 PUT 对象场景），
 * 与本地文件 md5 比对，只传变化的，多余的（源仓已删的文件）删掉。
 * 不做本地 state 缓存——CI 每次是干净 checkout，缓存文件活不到下一次跑；
 * 直接向 COS 问现状最简单可靠（数据量小，一次 ListBucket 够用）。
 *
 * 环境变量：
 *   COS_SECRET_ID / COS_SECRET_KEY / COS_BUCKET   （必填）与公开数据同一账号/桶，
 *                                                  靠前缀隔离，无需另开写权限。
 *   COS_REGION            可选，默认 ap-singapore——**须与公开桶实际所在地域一致**
 *                          （deploy.yml 里公开同步步骤显式传 ap-singapore，这里没传时
 *                          的默认值只是兜底，两处不一致会导致 404/签名地域错误）
 *   PRIVATE_COS_PREFIX    可选，默认 private/book-text-private（须与
 *                          edge-functions/api/private-text 的同名变量一致）
 *   BOOK_TEXT_PRIVATE_DIR （必填）本地 clone 路径
 *   DRY_RUN               可选，设为 1 只打印不上传/删除
 *
 * 用法：
 *   BOOK_TEXT_PRIVATE_DIR=../book-text-private node scripts/sync-private-text-to-cos.mjs
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { createHash } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

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
const REGION = process.env.COS_REGION || 'ap-singapore';
const PREFIX = (process.env.PRIVATE_COS_PREFIX || 'private/book-text-private').replace(/^\/+|\/+$/g, '');
const SOURCE_DIR = process.env.BOOK_TEXT_PRIVATE_DIR ? resolve(process.env.BOOK_TEXT_PRIVATE_DIR) : null;
const DRY_RUN = process.env.DRY_RUN === '1';

// 源仓里不进私有前缀的东西：.git 内部对象、顶层说明文档（不是要展示的正文）。
const EXCLUDE_TOP = new Set(['.git', 'README.md']);

if (!SOURCE_DIR || !existsSync(SOURCE_DIR)) {
    console.error(`❌ BOOK_TEXT_PRIVATE_DIR 未设置或不存在: ${SOURCE_DIR}`);
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

function walk(dir, base = dir, topLevel = true) {
    const out = [];
    for (const name of readdirSync(dir)) {
        if (topLevel && EXCLUDE_TOP.has(name)) continue;
        const full = join(dir, name);
        const stat = statSync(full);
        if (stat.isDirectory()) {
            for (const f of walk(full, base, false)) out.push(f);
        } else {
            const relative = full.slice(base.length + 1).split(/[\\/]/).join('/');
            out.push({ full, relative, size: stat.size });
        }
    }
    return out;
}

const files = walk(SOURCE_DIR);
const totalBytes = files.reduce((s, f) => s + f.size, 0);

console.log(`\nsync-private-text-to-cos`);
console.log(`  source: ${SOURCE_DIR} (${files.length} files, ${(totalBytes / 1024 / 1024).toFixed(1)} MB)`);
console.log(`  target: cos://${BUCKET}/${PREFIX}/  (ACL: private)`);
console.log(`  mode:   ${DRY_RUN ? 'DRY RUN' : 'UPLOAD'}\n`);

if (DRY_RUN) {
    for (const f of files.slice(0, 10)) console.log(`  ${PREFIX}/${f.relative}  (${f.size} B)`);
    if (files.length > 10) console.log(`  ...及另外 ${files.length - 10} 个文件`);
    console.log('\n(dry run, nothing uploaded)\n');
    process.exit(0);
}

let COS;
try {
    COS = require('cos-nodejs-sdk-v5');
} catch {
    console.error('❌ cos-nodejs-sdk-v5 not installed. Run: npm i -D cos-nodejs-sdk-v5');
    process.exit(1);
}

const cos = new COS({
    SecretId: SECRET_ID,
    SecretKey: SECRET_KEY,
    FileParallelLimit: 40,
    Timeout: 60 * 1000,
});

function contentTypeFor(relative) {
    const i = relative.lastIndexOf('.');
    const ext = i < 0 ? '' : relative.slice(i + 1).toLowerCase();
    switch (ext) {
        case 'json': return 'application/json; charset=utf-8';
        case 'md': return 'text/markdown; charset=utf-8';
        case 'txt': return 'text/plain; charset=utf-8';
        default: return 'application/octet-stream';
    }
}

function md5OfFile(path) {
    return createHash('md5').update(readFileSync(path)).digest('hex');
}

/** list 私有前缀下所有对象的 key(相对路径)→md5（ETag 去引号）。 */
async function listPrefixEtags(prefix) {
    const map = new Map();
    let marker = '';
    const stripQuotes = (s) => (s || '').replace(/^"|"$/g, '');
    while (true) {
        const res = await new Promise((resolveP, rejectP) => {
            cos.getBucket({
                Bucket: BUCKET, Region: REGION,
                Prefix: prefix, Marker: marker, MaxKeys: 1000,
            }, (err, data) => err ? rejectP(err) : resolveP(data));
        });
        for (const obj of res.Contents || []) {
            map.set(obj.Key.slice(prefix.length), stripQuotes(obj.ETag));
        }
        if (res.IsTruncated === 'true' || res.IsTruncated === true) {
            marker = res.NextMarker || res.Contents[res.Contents.length - 1].Key;
        } else break;
    }
    return map;
}

async function uploadOne(f, attempt = 1) {
    const key = `${PREFIX}/${f.relative}`;
    try {
        return await new Promise((resolveP, rejectP) => {
            cos.putObject({
                Bucket: BUCKET,
                Region: REGION,
                Key: key,
                Body: readFileSync(f.full),
                ContentType: contentTypeFor(f.relative),
                CacheControl: 'private, no-store',
                ACL: 'private', // 逐对象显式覆盖桶默认 ACL——这是「私有」二字唯一落地的地方
            }, (err) => err ? rejectP(err) : resolveP());
        });
    } catch (e) {
        const transient = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network/i.test(e.message || '');
        if (transient && attempt < 4) {
            await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
            return uploadOne(f, attempt + 1);
        }
        throw e;
    }
}

async function deleteOne(relative, attempt = 1) {
    const key = `${PREFIX}/${relative}`;
    try {
        return await new Promise((resolveP, rejectP) => {
            cos.deleteObject({ Bucket: BUCKET, Region: REGION, Key: key }, (err) => err ? rejectP(err) : resolveP());
        });
    } catch (e) {
        const transient = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network/i.test(e.message || '');
        if (transient && attempt < 4) {
            await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
            return deleteOne(relative, attempt + 1);
        }
        throw e;
    }
}

async function runQueue(items, concurrency, worker, label) {
    const queue = [...items];
    let done = 0;
    const failures = [];
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        while (queue.length > 0) {
            const item = queue.shift();
            if (!item) return;
            try {
                await worker(item);
                done += 1;
            } catch (e) {
                failures.push({ item, err: e.message });
                console.error(`  ⚠ ${label} failed: ${JSON.stringify(item).slice(0, 80)} — ${e.message}`);
            }
        }
    });
    await Promise.all(workers);
    console.log(`  ✓ ${label}: ${done}/${items.length}`);
    return failures;
}

async function main() {
    console.log(`  listing cos://${BUCKET}/${PREFIX}/ ...`);
    const remote = await listPrefixEtags(`${PREFIX}/`);
    console.log(`  remote has ${remote.size} objects`);

    const localRelSet = new Set(files.map((f) => f.relative));
    const toUpload = files.filter((f) => remote.get(f.relative) !== md5OfFile(f.full));
    const toDelete = [...remote.keys()].filter((rel) => !localRelSet.has(rel));

    console.log(`  plan: ${toUpload.length} upload/update · ${files.length - toUpload.length} unchanged · ${toDelete.length} delete\n`);

    const failures = [];
    if (toUpload.length > 0) failures.push(...await runQueue(toUpload, 20, uploadOne, 'upload'));
    if (toDelete.length > 0) failures.push(...await runQueue(toDelete, 20, deleteOne, 'delete'));

    if (failures.length > 0) {
        console.error(`\n❌ ${failures.length} op(s) failed.`);
        process.exit(2);
    }
    console.log(`\n✅ sync-private-text-to-cos complete\n`);
}

main().catch((err) => {
    console.error(`\n❌ Fatal: ${err.message}`);
    process.exit(1);
});
