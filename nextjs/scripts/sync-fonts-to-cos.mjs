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
 * 只传 COS 上还没有的 woff2（先 headObject），已有的跳过；一次都不删。
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
import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
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
const files = readdirSync(DIST)
    .filter((n) => /\.(woff2|txt|json)$/.test(n) && n !== 'hanamin.css')
    .sort()
    .map((name) => {
        const ext = name.slice(name.lastIndexOf('.'));
        return { name, full: join(DIST, name), size: statSync(join(DIST, name)).size, key: PREFIX + name, ext };
    });
const fonts = files.filter((f) => f.ext === '.woff2');
const docs = files.filter((f) => f.ext !== '.woff2');
if (fonts.length === 0) {
    console.error(`❌ ${DIST} 里没有 woff2`);
    process.exit(1);
}
if (!docs.some((f) => f.name === 'LICENSE.txt')) {
    console.error('❌ 缺 LICENSE.txt：授权文件必须随字体一起放');
    process.exit(1);
}

if (DRY_RUN) {
    console.log(`(dry run) 会检查并上传 ${fonts.length} 个 woff2（${(fonts.reduce((s, f) => s + f.size, 0) / 1e6).toFixed(1)} MB）与 ${docs.length} 个授权／清单文件到 ${PREFIX}`);
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

async function exists(key) {
    try {
        await call(cos.headObject, { Bucket: BUCKET, Region: REGION, Key: key });
        return true;
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
// 先传字体、后传授权／清单：授权文件缺了也不让字体单独上线
let next = 0;
async function worker() {
    while (next < fonts.length) {
        const f = fonts[next++];
        if (await exists(f.key)) { skipped++; continue; }
        await put(f, IMMUTABLE);
        uploaded++;
    }
}
await Promise.all(Array.from({ length: 8 }, worker));
for (const f of docs) await put(f, SHORT);
console.log(`✅ fonts/hanamin/：新传 ${uploaded} 个 woff2，已有 ${skipped} 个跳过，授权／清单 ${docs.length} 个已更新`);
