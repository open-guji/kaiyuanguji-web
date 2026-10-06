#!/usr/bin/env node
/**
 * sync-fonts-to-cos.mjs — 把 ops/fonts/build-hanamin.py 产出的花园明朝 woff2 传到 COS（overview#421）
 *
 * 目标：cos://{bucket}/fonts/hanamin/<文件名>，即 https://data.kaiyuanguji.com/fonts/hanamin/<文件名>。
 *   - 字体文件（*.woff2）：Cache-Control: public, max-age=31536000, immutable（文件名由规则与输入决定，
 *     同名同内容，永不覆盖；改规则加修订号 REV，旧名字照旧）；
 *   - LICENSE.txt、THANKS.txt（授权文件，Hanazono Font License／SIL OFL 1.1 双授权，随字体放）、manifest.json：
 *     短缓存（1 天），可随时更新。
 * 与 h1/、current/、v/ 前缀互不相干，不读不改不删它们；也不带 COS_PATH_PREFIX（测试站、正式站共用同一份字体）。
 * 只信 build-hanamin.py 最后写的 manifest.json：没有它就拒绝（说明构建没跑完或被中断）；每个 woff2 先按它里面的
 * 字节数与 sha256 核对，对不上就整个中止、什么都不传（不让半截的文件以 immutable 文件名上线）。
 * COS 上已有的 woff2 先 headObject 比字节数，一致才跳过，不一致重传；一次都不删。
 * 上传顺序：授权文件（LICENSE.txt、THANKS.txt）→ woff2 → manifest.json，没有授权文件就不会有公开的字体。
 *
 * 先传、后部署：globals.css 里的 @font-face 指向这些地址，文件没传上去就上线，扩展区字照旧显示空白。
 *
 * 用法：
 *   python3 ops/fonts/build-hanamin.py --write-globals          # 产出到 ops/fonts/dist/hanamin
 *   COS_SECRET_ID=… COS_SECRET_KEY=… COS_BUCKET=… node nextjs/scripts/sync-fonts-to-cos.mjs [<dist 目录>]
 *   DRY_RUN=1 node nextjs/scripts/sync-fonts-to-cos.mjs        # 只列出会传什么，不联网
 *
 * 环境变量：COS_SECRET_ID／COS_SECRET_KEY／COS_BUCKET／COS_REGION（默认 ap-singapore）／DRY_RUN。
 */
import { readFileSync, existsSync, statSync } from 'fs';
import { createHash } from 'crypto';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { requireCosSdk } from './lib/h1-sync-core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(process.argv[2] || join(__dirname, '..', '..', 'ops', 'fonts', 'dist', 'hanamin'));
const PREFIX = 'fonts/hanamin/';
const IMMUTABLE = 'public, max-age=31536000, immutable';
const SHORT = 'public, max-age=86400';
const DRY_RUN = process.env.DRY_RUN === '1';

const SECRET_ID = process.env.COS_SECRET_ID;
const SECRET_KEY = process.env.COS_SECRET_KEY;
const BUCKET = process.env.COS_BUCKET;
const REGION = process.env.COS_REGION || 'ap-singapore';

if (!existsSync(DIST)) {
    console.error(`❌ ${DIST} 不存在。先跑 python3 ops/fonts/build-hanamin.py`);
    process.exit(1);
}

const CONTENT_TYPES = { '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json' };
const extOf = (name) => name.slice(name.lastIndexOf('.'));
const mk = (name, size) => ({ name, full: join(DIST, name), size, key: PREFIX + name, ext: extOf(name) });

// manifest.json 是 build-hanamin.py 最后写的：有它才说明 dist 里的文件都写完了
const manifestPath = join(DIST, 'manifest.json');
if (!existsSync(manifestPath)) {
    console.error(`❌ ${manifestPath} 不存在：构建没跑完或被中断，先重跑 python3 ops/fonts/build-hanamin.py`);
    process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
const fonts = [];
for (const [name, meta] of Object.entries(manifest.files ?? {})) {
    if (!/^[\w.-]+\.woff2$/.test(name)) {
        console.error(`❌ manifest 里有不合规的文件名：${name}`);
        process.exit(1);
    }
    const full = join(DIST, name);
    if (!existsSync(full)) {
        console.error(`❌ ${name} 在 manifest 里但磁盘上没有`);
        process.exit(1);
    }
    const body = readFileSync(full);
    const sha = createHash('sha256').update(body).digest('hex');
    if (body.length !== meta.bytes || sha !== meta.sha256) {
        console.error(`❌ ${name} 与 manifest 对不上（字节 ${body.length}／${meta.bytes}，sha256 ${sha.slice(0, 8)}／${String(meta.sha256).slice(0, 8)}）：文件不完整或被改过，重跑构建`);
        process.exit(1);
    }
    fonts.push(mk(name, body.length));
}
const docs = ['LICENSE.txt', 'THANKS.txt'].map((n) => {
    if (!existsSync(join(DIST, n))) {
        console.error(`❌ 缺 ${n}：授权文件必须随字体一起放`);
        process.exit(1);
    }
    return mk(n, statSync(join(DIST, n)).size);
});
if (fonts.length === 0) {
    console.error('❌ manifest 里没有 woff2');
    process.exit(1);
}
const files = [...docs, ...fonts.sort((a, b) => a.name.localeCompare(b.name)), mk('manifest.json', statSync(manifestPath).size)];

if (DRY_RUN) {
    console.log(`(dry run) manifest 核对通过；会按「授权文件 → woff2 → manifest」的顺序检查并上传 ${fonts.length} 个 woff2（${(fonts.reduce((s, f) => s + f.size, 0) / 1e6).toFixed(1)} MB）与 ${docs.length + 1} 个授权／清单文件到 ${PREFIX}`);
    for (const f of files) console.log(`  ${f.key}  ${f.size} B  ${f.ext === '.woff2' ? IMMUTABLE : SHORT}`);
    process.exit(0);
}
for (const [name, val] of Object.entries({ COS_SECRET_ID: SECRET_ID, COS_SECRET_KEY: SECRET_KEY, COS_BUCKET: BUCKET })) {
    if (!val) {
        console.error(`❌ Missing env ${name}`);
        process.exit(1);
    }
}

const COS = requireCosSdk();
const cos = new COS({ SecretId: SECRET_ID, SecretKey: SECRET_KEY, Timeout: 60 * 1000 });
const call = (fn, params) => new Promise((ok, ng) => fn.call(cos, params, (err, data) => (err ? ng(err) : ok(data))));

/** COS 上已有同名对象且字节数一致才算「已有」；返回 false 就（重）传 */
async function exists(key, size) {
    try {
        const head = await call(cos.headObject, { Bucket: BUCKET, Region: REGION, Key: key });
        const len = Number(head?.headers?.['content-length'] ?? head?.headers?.['Content-Length']);
        return len === size;
    } catch (e) {
        if (e && (e.statusCode === 404 || e.code === 'NoSuchKey' || e.code === '404')) return false;
        throw e;
    }
}

async function put(f, cacheControl, attempt = 1) {
    try {
        await call(cos.putObject, {
            Bucket: BUCKET, Region: REGION, Key: f.key,
            Body: readFileSync(f.full), ContentType: CONTENT_TYPES[f.ext], CacheControl: cacheControl,
        });
    } catch (e) {
        if (attempt >= 4) throw e;
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        return put(f, cacheControl, attempt + 1);
    }
}

let uploaded = 0, skipped = 0;
// 先传授权文件，再传字体，最后传清单：没有授权文件就不会有公开的字体
for (const f of docs) await put(f, SHORT);
let next = 0;
async function worker() {
    while (next < fonts.length) {
        const f = fonts[next++];
        if (await exists(f.key, f.size)) { skipped++; continue; }
        await put(f, IMMUTABLE);
        uploaded++;
    }
}
await Promise.all(Array.from({ length: 8 }, worker));
await put(files[files.length - 1], SHORT);
console.log(`✅ fonts/hanamin/：新传 ${uploaded} 个 woff2，已有 ${skipped} 个跳过（字节数一致），授权／清单 ${docs.length + 1} 个已更新`);
