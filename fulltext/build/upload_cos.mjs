#!/usr/bin/env node
/**
 * 把全文索引包传到 COS，并翻转 latest.json 指针（设计见 fulltext/docs/design.md「三、数据流」）。
 *
 * 用法：node upload_cos.mjs --pack <fulltext-STAMP.tar.gz> --manifest <manifest.json> [--prefix fulltext] [--keep 2] [--dry-run]
 * 环境变量：COS_SECRET_ID、COS_SECRET_KEY、COS_BUCKET、COS_REGION（默认 ap-shanghai）。凭据只从环境读，不打印。
 *   COS_ACCELERATE=1 走全球加速域名（桶要先在控制台开通全球加速，按流量另计费）。
 *   COS_PART_MB（默认 4）、COS_PARALLEL（默认 8）：分块大小与并发。实测 16 MB×12 时单块太慢，COS 反复回 UserNetworkTooSlow（总速 0.03 MB/s）；
 *   SDK 默认的 4 MB×8 约 0.9 MB/s。块要小，单个请求才能在 COS 的慢速判定前传完。
 *
 * 大包自己分块上传（不用 SDK 的 uploadFile）：美国 runner 传上海桶约 1 MB/s，单块慢了 COS 会回 UserNetworkTooSlow，
 * SDK 整体重试会白传。这里每块单独重试；中途失败重跑时，按 ListParts 续传（块号、大小、MD5 都对上的跳过）。
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
import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export class Fail extends Error {
    constructor(code, msg) { super(msg); this.code = code; }
}

export function parseArgs(argv) {
    const a = { prefix: 'fulltext', keep: 2, dryRun: false,
                partMB: Number(process.env.COS_PART_MB || 4), parallel: Number(process.env.COS_PARALLEL || 8) };
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
    if (!(a.partMB >= 1 && a.partMB <= 1024) || !(Number.isInteger(a.parallel) && a.parallel >= 1 && a.parallel <= 64)) {
        throw new Fail(2, 'COS_PART_MB 要在 1–1024、COS_PARALLEL 要在 1–64');
    }
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

export const isTransient = e => e?.statusCode >= 500 ||
    /ECONNRESET|EPIPE|ETIMEDOUT|ESOCKETTIMEDOUT|EAI_AGAIN|socket hang up|network|TooSlow|RequestTimeout|Signature|RequestTimeTooSkewed|expired|timeout/i
        .test(`${e?.message || ''} ${e?.code || ''} ${e?.error?.Code || ''}`);

/** COS SDK 的回调接口包成 Promise，并对网络／签名类错误重试（美国 runner 传上海桶偶发断连、签名过期、UserNetworkTooSlow）。 */
export function wrapClient(cos, { bucket, region, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
    const call = (method, params) => new Promise((res, rej) =>
        cos[method]({ Bucket: bucket, Region: region, ...params }, (err, data) => err ? rej(err) : res(data)));
    const retry = async (method, params, tries = 4) => {
        for (let i = 1; ; i++) {
            try { return await call(method, params); } catch (e) {
                if (e?.statusCode === 404 || !isTransient(e) || i >= tries) throw e;
                await sleep(Math.min(60000, 1000 * 2 ** i));
            }
        }
    };
    return {
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
        // 分块上传原语（续传用）
        mpFind: async Key => {
            const d = await retry('multipartList', { Prefix: Key });
            const ups = (d.Upload || []).filter(u => u.Key === Key).sort((a, b) => String(b.Initiated).localeCompare(String(a.Initiated)));
            return ups[0]?.UploadId || null;
        },
        mpInit: async (Key, extra = {}) => (await retry('multipartInit', { Key, ...extra })).UploadId,
        mpParts: async (Key, UploadId) => {
            const parts = []; let PartNumberMarker;
            do {
                const d = await retry('multipartListPart', { Key, UploadId, PartNumberMarker, MaxParts: 1000 });
                for (const p of d.Part || []) parts.push({ PartNumber: Number(p.PartNumber), ETag: p.ETag, Size: Number(p.Size) });
                PartNumberMarker = d.IsTruncated === 'true' || d.IsTruncated === true ? d.NextPartNumberMarker : undefined;
            } while (PartNumberMarker);
            return parts;
        },
        // 单块只试一次，重试由 uploadLarge 控制（要换新 Body、记次数）
        mpPut: async (Key, UploadId, PartNumber, Body) => (await call('multipartUpload', { Key, UploadId, PartNumber, Body })).ETag,
        mpComplete: (Key, UploadId, Parts) => retry('multipartComplete', { Key, UploadId, Parts }),
    };
}

const unq = s => String(s || '').replace(/"/g, '').toLowerCase();

/**
 * 分块上传大文件：每块独立重试，可续传。
 * opts: partSize、parallel、partTries（每块最多试几次）、extra（Init 时的 ContentType/CacheControl）、log、sleep。
 */
export async function uploadLarge(client, key, path, size, opts = {}) {
    const { partSize = 4 * 2 ** 20, parallel = 8, partTries = 20, extra = {}, log = console.log,
            sleep = ms => new Promise(r => setTimeout(r, ms)), now = () => Date.now() } = opts;
    const n = Math.max(1, Math.ceil(size / partSize));
    if (n > 10000) throw new Fail(2, `分块数 ${n} 超过 COS 上限 10000，调大 COS_PART_MB`);
    const fh = await open(path, 'r');
    try {
        const read = async i => {
            const len = Math.min(partSize, size - (i - 1) * partSize);
            const buf = Buffer.alloc(len);
            await fh.read(buf, 0, len, (i - 1) * partSize);
            return buf;
        };
        let uploadId = await client.mpFind(key);
        const done = new Map();
        if (uploadId) {
            for (const p of await client.mpParts(key, uploadId)) {
                if (p.PartNumber < 1 || p.PartNumber > n) continue;
                const buf = await read(p.PartNumber);
                if (p.Size === buf.length && unq(p.ETag) === createHash('md5').update(buf).digest('hex')) done.set(p.PartNumber, p.ETag);
            }
            log(`续传：已有分块上传，${done.size}/${n} 块可复用`);
        } else {
            uploadId = await client.mpInit(key, extra);
        }
        const todo = []; for (let i = 1; i <= n; i++) if (!done.has(i)) todo.push(i);
        const t0 = now(); let sent = 0, lastPct = -1, retries = 0;
        const total = todo.reduce((a, i) => a + Math.min(partSize, size - (i - 1) * partSize), 0);
        const worker = async () => {
            while (todo.length) {
                const i = todo.shift();
                const buf = await read(i);
                for (let t = 1; ; t++) {
                    try { done.set(i, await client.mpPut(key, uploadId, i, buf)); break; } catch (e) {
                        if (!isTransient(e) || t >= partTries) throw new Fail(6, `第 ${i} 块上传失败（试了 ${t} 次）：${e?.message || e?.code || e}`);
                        retries++;
                        await sleep(Math.min(60000, 2000 * 2 ** (t - 1)));
                    }
                }
                sent += buf.length;
                const pct = Math.floor(100 * sent / Math.max(1, total) / 5) * 5;
                if (pct > lastPct) {
                    lastPct = pct;
                    const sec = Math.max(1, (now() - t0) / 1000), mbps = sent / 2 ** 20 / sec;
                    log(`  ${pct}%  ${(sent / 2 ** 30).toFixed(2)}/${(total / 2 ** 30).toFixed(2)} GiB  ${mbps.toFixed(2)} MB/s  ` +
                        `还要约 ${Math.round((total - sent) / 2 ** 20 / Math.max(mbps, 0.01) / 60)} 分  重试 ${retries} 次`);
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(parallel, Math.max(1, todo.length)) }, worker));
        const parts = [...done.entries()].sort((a, b) => a[0] - b[0]).map(([PartNumber, ETag]) => ({ PartNumber, ETag }));
        await client.mpComplete(key, uploadId, parts);
    } finally {
        await fh.close();
    }
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
    await uploadLarge(client, keys.pack, a.pack, packBytes, {
        partSize: a.partMB * 2 ** 20, parallel: a.parallel, log,
        extra: { ContentType: 'application/gzip', CacheControl: 'public, max-age=31536000, immutable' } });
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

// SDK 在请求被 COS 掐断后偶尔还会在已废弃的 TLS socket 上抛 EPIPE/ECONNRESET（无人监听 → 进程崩）。
// 这类错误对应的请求已经以失败回调过、会被重试，忽略即可；别的未捕获错误照常退出 6。
export function onStray(e, log = console.error) {
    if (/EPIPE|ECONNRESET|ETIMEDOUT|socket hang up/i.test(`${e?.code || ''} ${e?.message || ''}`)) {
        log(`忽略游离的 socket 错误：${e?.code || e?.message}`);
        return true;
    }
    return false;
}

async function main() {
    process.on('uncaughtException', e => {
        if (onStray(e)) return;
        console.error(`ERROR[6] 未捕获：${e?.stack || e}`);
        process.exit(6);
    });
    let a;
    try {
        a = parseArgs(process.argv.slice(2));
        const need = ['COS_SECRET_ID', 'COS_SECRET_KEY', 'COS_BUCKET'].filter(k => !process.env[k]);
        let client = null;
        if (!a.dryRun || !need.length) {
            if (need.length) throw new Fail(2, `缺环境变量 ${need.join('、')}`);
            const COS = createRequire(import.meta.url)('cos-nodejs-sdk-v5');
            const cos = new COS({ SecretId: process.env.COS_SECRET_ID, SecretKey: process.env.COS_SECRET_KEY,
                                  Timeout: 10 * 60 * 1000, UseAccelerate: process.env.COS_ACCELERATE === '1' });
            if (process.env.COS_ACCELERATE === '1') console.log('走全球加速域名');
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
