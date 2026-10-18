#!/usr/bin/env node
/**
 * 把全文索引包传到 COS，并翻转 latest.json 指针（设计见 fulltext/docs/design.md「三、数据流」）。
 *
 * 用法：node upload_cos.mjs --pack <fulltext-STAMP.tar.gz> --manifest <manifest.json> [--prefix fulltext] [--keep 2] [--dry-run]
 * 环境变量：COS_SECRET_ID、COS_SECRET_KEY、COS_BUCKET、COS_REGION（默认 ap-shanghai）。凭据只从环境读，不打印。
 *
 * 写入：
 *   <prefix>/<stamp>/fulltext-<stamp>.tar.gz   包（分块上传）
 *   <prefix>/<stamp>/manifest.json             与包内同一份
 *   <prefix>/latest.json                       指针（最后写，短缓存）：{stamp, schemaVersion, createdAtEpoch, bookTextCommit,
 *                                              pack, manifest, packBytes, packSha256, books, passages, indexBytes}
 * 拒传：manifest 不是 v2、标了 partial、或线上 latest.json 比本包新（createdAtEpoch 更大）。
 * 清理：只留最新 keep 个 stamp（latest 指向的那个永远保留）。
 * 退出码：0 成功；2 参数错；4 manifest 不合格；5 线上已有更新的包；6 上传或校验失败。
 */
import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export class Fail extends Error {
    constructor(code, msg) { super(msg); this.code = code; }
}

export function parseArgs(argv) {
    const a = { prefix: 'fulltext', keep: 2, dryRun: false };
    for (let i = 0; i < argv.length; i++) {
        const k = argv[i];
        if (k === '--pack') a.pack = argv[++i];
        else if (k === '--manifest') a.manifest = argv[++i];
        else if (k === '--prefix') a.prefix = argv[++i];
        else if (k === '--keep') a.keep = Number(argv[++i]);
        else if (k === '--dry-run') a.dryRun = true;
        else throw new Fail(2, `未知参数 ${k}`);
    }
    if (!a.pack || !a.manifest) throw new Fail(2, '必须给 --pack 和 --manifest');
    if (!Number.isInteger(a.keep) || a.keep < 1) throw new Fail(2, '--keep 必须是正整数');
    a.prefix = String(a.prefix).replace(/^\/+|\/+$/g, '');
    if (!a.prefix || a.prefix.split('/').includes('..')) throw new Fail(2, '--prefix 不合法');
    return a;
}

export function checkManifest(m, packName) {
    const bad = [];
    if (m.schemaVersion !== 2) bad.push(`schemaVersion=${m.schemaVersion}（要 2）`);
    if (!/^\d{8}-\d{4}$/.test(String(m.stamp))) bad.push(`stamp=${m.stamp}`);
    if (!Number.isInteger(m.createdAtEpoch)) bad.push('createdAtEpoch');
    if (m.partial) bad.push('partial=true（试跑产物）');
    for (const k of ['books', 'passages', 'indexBytes']) if (!(Number.isInteger(m[k]) && m[k] > 0)) bad.push(k);
    if (packName !== `fulltext-${m.stamp}.tar.gz`) bad.push(`包名 ${packName} 与 stamp ${m.stamp} 不符`);
    if (bad.length) throw new Fail(4, `manifest 不合格：${bad.join('；')}`);
}

/** 从 key 列表里挑要删的 stamp 目录：保留最新 keep 个，以及 latest 指向的那个。 */
export function stampsToPrune(keys, prefix, keep, protect) {
    const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(\\d{8}-\\d{4})/`);
    const stamps = [...new Set(keys.map(k => (k.match(re) || [])[1]).filter(Boolean))].sort().reverse();
    const keepSet = new Set([...stamps.slice(0, keep), ...protect.filter(Boolean)]);
    return stamps.filter(s => !keepSet.has(s));
}

export function sha256File(path) {
    return new Promise((res, rej) => {
        const h = createHash('sha256');
        createReadStream(path).on('data', d => h.update(d)).on('end', () => res(h.digest('hex'))).on('error', rej);
    });
}

/** COS SDK 的回调接口包成 Promise，并对网络／签名类错误重试（美国 runner 传上海桶偶发断连、签名过期）。 */
export function wrapClient(cos, { bucket, region, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
    const transient = e => /ECONNRESET|EPIPE|ETIMEDOUT|EAI_AGAIN|socket hang up|network|Signature|RequestTimeTooSkewed|expired/i
        .test(`${e?.message || ''} ${e?.code || ''}`);
    const call = (method, params) => new Promise((res, rej) =>
        cos[method]({ Bucket: bucket, Region: region, ...params }, (err, data) => err ? rej(err) : res(data)));
    const retry = async (method, params, tries = 4) => {
        for (let i = 1; ; i++) {
            try { return await call(method, params); } catch (e) {
                if (e?.statusCode === 404 || !transient(e) || i >= tries) throw e;
                await sleep(1000 * 2 ** i);
            }
        }
    };
    return {
        uploadFile: (Key, FilePath, extra = {}) => retry('uploadFile', {
            Key, FilePath, SliceSize: 1024 * 1024, ChunkSize: 4 * 1024 * 1024, AsyncLimit: 8, ...extra }),
        putJson: (Key, obj, CacheControl) => retry('putObject', {
            Key, Body: Buffer.from(JSON.stringify(obj, null, 1)), ContentType: 'application/json; charset=utf-8', CacheControl }),
        head: Key => retry('headObject', { Key }),
        getJson: async Key => {
            try { return JSON.parse(String((await retry('getObject', { Key })).Body)); } catch (e) {
                if (e?.statusCode === 404) return null;
                throw e;
            }
        },
        list: async Prefix => {
            const keys = []; let Marker;
            do {
                const d = await retry('getBucket', { Prefix, Marker, MaxKeys: 1000 });
                for (const c of d.Contents || []) keys.push(c.Key);
                Marker = d.IsTruncated === 'true' || d.IsTruncated === true ? d.NextMarker : undefined;
            } while (Marker);
            return keys;
        },
        deleteMany: keys => keys.length ? retry('deleteMultipleObject', { Objects: keys.map(Key => ({ Key })) }) : null,
    };
}

export async function run(a, client, log = console.log) {
    const m = JSON.parse(readFileSync(a.manifest, 'utf8'));
    const packName = basename(a.pack);
    checkManifest(m, packName);
    const packBytes = statSync(a.pack).size;
    const dir = `${a.prefix}/${m.stamp}`;
    const keys = { pack: `${dir}/${packName}`, manifest: `${dir}/manifest.json`, latest: `${a.prefix}/latest.json` };

    const online = await client.getJson(keys.latest);
    if (online && online.createdAtEpoch > m.createdAtEpoch) {
        throw new Fail(5, `线上 latest 是 ${online.stamp}（更新），本包 ${m.stamp} 不覆盖`);
    }
    log(`包 ${packName} ${(packBytes / 2 ** 30).toFixed(2)} GiB，算 sha256…`);
    const packSha256 = await sha256File(a.pack);
    const latest = {
        stamp: m.stamp, schemaVersion: m.schemaVersion, createdAtEpoch: m.createdAtEpoch, bookTextCommit: m.bookTextCommit,
        pack: keys.pack, manifest: keys.manifest, packBytes, packSha256,
        books: m.books, passages: m.passages, indexBytes: m.indexBytes,
    };
    if (a.dryRun) {
        log(`[dry-run] 会写 ${keys.pack}、${keys.manifest}，再把 ${keys.latest} 指向 ${m.stamp}`);
        return latest;
    }
    const t0 = Date.now();
    await client.uploadFile(keys.pack, a.pack, { ContentType: 'application/gzip', CacheControl: 'public, max-age=31536000, immutable' });
    const head = await client.head(keys.pack);
    const got = Number(head?.headers?.['content-length'] ?? head?.ContentLength);
    if (got !== packBytes) throw new Fail(6, `上传后大小 ${got} ≠ 本地 ${packBytes}`);
    log(`包已上传并核对大小，用时 ${Math.round((Date.now() - t0) / 1000)} 秒`);
    await client.putJson(keys.manifest, m, 'public, max-age=31536000, immutable');
    await client.putJson(keys.latest, latest, 'no-cache');
    log(`latest.json → ${m.stamp}`);

    const all = await client.list(`${a.prefix}/`);
    const prune = stampsToPrune(all, a.prefix, a.keep, [m.stamp]);
    if (prune.length) {
        const del = all.filter(k => prune.some(s => k.startsWith(`${a.prefix}/${s}/`)));
        await client.deleteMany(del);
        log(`清理旧包：${prune.join('、')}（${del.length} 个对象）`);
    }
    return latest;
}

async function main() {
    let a;
    try {
        a = parseArgs(process.argv.slice(2));
        const need = ['COS_SECRET_ID', 'COS_SECRET_KEY', 'COS_BUCKET'].filter(k => !process.env[k]);
        let client = null;
        if (!a.dryRun || !need.length) {
            if (need.length) throw new Fail(2, `缺环境变量 ${need.join('、')}`);
            const COS = createRequire(import.meta.url)('cos-nodejs-sdk-v5');
            const cos = new COS({ SecretId: process.env.COS_SECRET_ID, SecretKey: process.env.COS_SECRET_KEY, ChunkRetryTimes: 4 });
            client = wrapClient(cos, { bucket: process.env.COS_BUCKET, region: process.env.COS_REGION || 'ap-shanghai' });
        } else {
            client = { getJson: async () => null };   // dry-run 且没有凭据：不连 COS
        }
        const latest = await run(a, client);
        console.log(JSON.stringify(latest));
    } catch (e) {
        console.error(`ERROR[${e.code ?? 6}] ${e.message}`);
        process.exit(Number.isInteger(e.code) ? e.code : 6);
    }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
