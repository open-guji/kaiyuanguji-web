#!/usr/bin/env node
/**
 * upload-sitemaps.mjs — 把 gen-sitemaps.mjs 生成的条目 sitemap 传到数据前缀（overview#470 P1，逻辑见 lib/sitemap-upload.mjs）。
 *
 * 用法：SITEMAP_OUT_DIR=<gen-sitemaps 的输出目录> node scripts/upload-sitemaps.mjs [--dry-run]
 * 环境变量：
 *   SITEMAP_OUT_DIR   必填（不设默认值：免得误把 nextjs/public 里别的东西传上去）
 *   COS_SECRET_ID／COS_SECRET_KEY／COS_BUCKET／COS_REGION   --dry-run 时不需要
 *   COS_PATH_PREFIX   空＝正式站根；staging＝演练前缀
 * 只写 `<前缀>/sitemaps/*.xml`（并清掉该目录下已不在这一版里的旧分片），不碰别的对象。失败 exit 1。
 */
import { createRequire } from 'node:module';
import { publishSitemaps } from './lib/sitemap-upload.mjs';

const require = createRequire(import.meta.url);
const dryRun = process.argv.includes('--dry-run');
const DIR = process.env.SITEMAP_OUT_DIR;
const { COS_SECRET_ID, COS_SECRET_KEY, COS_BUCKET } = process.env;
const REGION = process.env.COS_REGION || 'ap-shanghai';
const PREFIX = (process.env.COS_PATH_PREFIX || '').replace(/^\/+|\/+$/g, '');

function cosBackend() {
    for (const [k, v] of Object.entries({ COS_SECRET_ID, COS_SECRET_KEY, COS_BUCKET })) {
        if (!v) throw new Error(`缺环境变量 ${k}`);
    }
    const COS = require('cos-nodejs-sdk-v5');
    const cos = new COS({ SecretId: COS_SECRET_ID, SecretKey: COS_SECRET_KEY, Timeout: 60 * 1000 });
    const call = (fn, args) => new Promise((ok, ng) => fn.call(cos, { Bucket: COS_BUCKET, Region: REGION, ...args }, (e, d) => (e ? ng(e) : ok(d))));
    return {
        put: (Key, Body, { contentType, cacheControl }) => call(cos.putObject, { Key, Body, ContentType: contentType, CacheControl: cacheControl }),
        async get(Key) {
            try { return (await call(cos.getObject, { Key })).Body; } catch (e) {
                if (e && (e.statusCode === 404 || e.code === 'NoSuchKey')) return null;
                throw e;
            }
        },
        async list(Prefix) {
            const keys = [];
            let Marker = '';
            for (;;) {
                const d = await call(cos.getBucket, { Prefix, Marker, MaxKeys: 1000 });
                for (const c of d.Contents || []) keys.push({ key: c.Key, lastModified: Date.parse(c.LastModified) });
                if (d.IsTruncated !== 'true' && d.IsTruncated !== true) return keys;
                Marker = d.NextMarker || keys[keys.length - 1].key;
            }
        },
        async del(keys) {
            for (let i = 0; i < keys.length; i += 1000) {
                const d = await call(cos.deleteMultipleObject, { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })) });
                // 批量删除整体成功时，单个对象仍可能删失败，错误在响应的 Error 里
                if (d && Array.isArray(d.Error) && d.Error.length) {
                    throw new Error(`${d.Error.length} 个对象没删掉：${d.Error.slice(0, 3).map((e) => `${e.Key}(${e.Code})`).join(', ')}`);
                }
            }
        },
    };
}

async function main() {
    if (!DIR) throw new Error('缺环境变量 SITEMAP_OUT_DIR（gen-sitemaps.mjs 的输出目录）');
    let meta = null;
    if (process.env.SITEMAP_META) {
        try { meta = JSON.parse(process.env.SITEMAP_META); } catch (e) { throw new Error(`SITEMAP_META 不是合法 JSON：${e.message}`); }
    }
    const r = await publishSitemaps({
        dir: DIR, prefix: PREFIX, dryRun, meta, log: (m) => console.log(m),
        backend: dryRun ? null : cosBackend(),
    });
    console.log(dryRun
        ? `✓ dry-run：检查通过，将传 ${r.planned} 个对象`
        : `✓ sitemap 已上传：${r.uploaded} 个对象，${(r.bytes / 1048576).toFixed(1)} MB，清理旧分片 ${r.pruned} 个`);
}

main().catch((e) => {
    console.error(`❌ ${e && e.message}`);
    process.exit(1);
});
