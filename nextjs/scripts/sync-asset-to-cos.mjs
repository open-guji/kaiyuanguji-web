#!/usr/bin/env node
/**
 * sync-asset-to-cos.mjs — 把图仓 book-index-asset（印影图）增量同步到 COS 的 asset/ 前缀（GUJI-544）
 *
 * 布局：cos://{bucket}/[{prefix}/]asset/entity/{c1}/{c2}/{c3}/{id}/{序号}.webp
 *   网站取图 URL ＝ https://data.kaiyuanguji.com/[{prefix}/]asset/ ＋ book-index 里 images[].file
 *
 * 与数据发布完全分开：不进 current/、不进数据包、不改 ?v= 与 latest.json；COS 密钥只在上传步骤 env。
 * 图仓约定「图只增不改名，换图用新序号」，所以一律 1 年 immutable，平时不需要刷新；
 * 同一路径内容变了（误覆盖）照传但列出来，用 edgeone-purge-urls 刷那几条 URL。
 * 孤儿（COS 有、仓里没有）只报告，不删。
 *
 * 环境变量：ASSET_ROOT（图仓本地路径，必填）、COS_SECRET_ID／COS_SECRET_KEY／COS_BUCKET、COS_REGION（默认 ap-shanghai）、
 *   COS_PATH_PREFIX（staging 演练用）、DRY_RUN=1（只算计划，不连 COS 写；仍会 LIST 桶，需要密钥——没有密钥时按「COS 上全空」估）
 * 用法：ASSET_ROOT=../book-index-asset node scripts/sync-asset-to-cos.mjs
 */
import { readFileSync, readdirSync, statSync, existsSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, posix } from 'node:path';
import { requireCosSdk, createCosOps, runQueue } from './lib/h1-sync-core.mjs';
import { planAssetSync } from './lib/asset-sync-plan.mjs';

const ROOT = process.env.ASSET_ROOT ? resolve(process.env.ASSET_ROOT) : '';
const DRY_RUN = process.env.DRY_RUN === '1';
const REGION = process.env.COS_REGION || 'ap-shanghai';
const PREFIX = (process.env.COS_PATH_PREFIX || '').replace(/^\/+|\/+$/g, '');
const ASSET_PREFIX = [PREFIX, 'asset'].filter(Boolean).join('/') + '/';
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';

if (!ROOT || !existsSync(ROOT)) { console.error('❌ ASSET_ROOT 未设或不存在'); process.exit(1); }
const haveKeys = !!(process.env.COS_SECRET_ID && process.env.COS_SECRET_KEY && process.env.COS_BUCKET);
if (!DRY_RUN && !haveKeys) { console.error('❌ 缺 COS_SECRET_ID／COS_SECRET_KEY／COS_BUCKET'); process.exit(1); }

/** 本地 entity/ 下所有文件 → 相对路径 → {md5,size,full}；只看 entity/，README 等不参与 */
function scanLocal() {
    const map = new Map();
    const base = join(ROOT, 'entity');
    if (!existsSync(base)) return map;
    const walk = (dir) => {
        for (const name of readdirSync(dir)) {
            const full = join(dir, name);
            const st = statSync(full);
            if (st.isDirectory()) { walk(full); continue; }
            const rel = posix.join('entity', full.slice(base.length + 1).split(/[\\/]/).join('/'));
            map.set(rel, { md5: createHash('md5').update(readFileSync(full)).digest('hex'), size: st.size, full });
        }
    };
    walk(base);
    return map;
}

const local = scanLocal();
let cosOps = null;
let remote = new Map();
if (haveKeys) {
    const COS = requireCosSdk();
    const cos = new COS({ SecretId: process.env.COS_SECRET_ID, SecretKey: process.env.COS_SECRET_KEY, Timeout: 60 * 1000 });
    cosOps = createCosOps({ cos, bucket: process.env.COS_BUCKET, region: REGION });
    remote = await cosOps.listPrefixEtags(ASSET_PREFIX);
} else {
    console.log('· DRY_RUN 且没有 COS 密钥：按「COS 上全空」估计划');
}

const plan = planAssetSync(local, remote);
const line = (k, n) => console.log(`· ${k}: ${n}`);
line('本地图', local.size); line('COS 现有', remote.size);
line('新增', plan.add.length); line('相同(跳过)', plan.same.length);
line('内容变了(误覆盖?)', plan.changed.length); line('孤儿(只报告)', plan.orphans.length); line('拒收', plan.rejected.length);

const summary = [];
summary.push(`### asset-sync（前缀 \`${ASSET_PREFIX}\`${DRY_RUN ? '，演练：只算计划' : ''}）`);
summary.push(`新增 ${plan.add.length} · 相同 ${plan.same.length} · 内容变了 ${plan.changed.length} · 孤儿 ${plan.orphans.length} · 拒收 ${plan.rejected.length}`);
for (const r of plan.rejected) { console.log(`::error::拒收 ${r.rel}：${r.why}`); summary.push(`- ❌ 拒收 \`${r.rel}\`：${r.why}`); }
for (const rel of plan.changed) {
    console.log(`::warning::${rel} 内容与 COS 上不同（图应只增不改名）；已覆盖，请用 edgeone-purge-urls 刷 URL`);
    summary.push(`- ⚠️ 内容变了 \`${rel}\`（需 purge）`);
}
for (const rel of plan.orphans) summary.push(`- ℹ️ 孤儿（不删）\`${rel}\``);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join('\n') + '\n');

if (plan.rejected.length) { console.error('❌ 有拒收的文件，停止上传（先在图仓修正）'); process.exit(1); }

const todo = [...plan.add, ...plan.changed];
if (DRY_RUN || todo.length === 0) { console.log(DRY_RUN ? '· DRY_RUN：不上传' : '· 没有要传的'); process.exit(0); }

let done = 0, failed = 0;
await runQueue(todo, 8, async (rel) => {
    try {
        await cosOps.uploadOne(local.get(rel), ASSET_PREFIX + rel, IMMUTABLE_CACHE, 'image/webp');
        done++;
    } catch (e) {
        failed++; console.error(`::error::上传失败 ${rel}：${e?.message || e}`);
    }
}, 'asset');
console.log(`· 上传完成 ${done}，失败 ${failed}`);
process.exit(failed ? 1 : 0);
