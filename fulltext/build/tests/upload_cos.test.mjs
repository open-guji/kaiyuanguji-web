// upload_cos.mjs 单测（假 COS 客户端，不连网）。运行：node --test fulltext/build/tests/
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { checkManifest, isTransient, onStray, parseArgs, run, stampsToPrune, uploadLarge, wrapClient } from '../upload_cos.mjs';

const M = { schemaVersion: 2, stamp: '20261018-0100', createdAtEpoch: 2000, bookTextCommit: 'a'.repeat(40),
            books: 1, passages: 10, indexBytes: 100 };

function fixture(m = M) {
    const d = mkdtempSync(join(tmpdir(), 'ftup-'));
    const pack = join(d, `fulltext-${m.stamp}.tar.gz`);
    writeFileSync(pack, Buffer.alloc(1234, 7));
    const manifest = join(d, 'manifest.json');
    writeFileSync(manifest, JSON.stringify(m));
    return { pack, manifest };
}

function fakeClient(objects = {}) {
    const store = { ...objects };
    const calls = [];
    return {
        store, calls,
        getJson: async k => (k in store ? JSON.parse(store[k]) : null),
        mpFind: async k => null,
        mpInit: async k => { calls.push(['upload', k]); return 'U1'; },
        mpParts: async () => [],
        mpPut: async (k, u, i, buf) => { (store.__parts ||= {})[i] = buf; return `"${i}"`; },
        mpComplete: async (k, u, parts) => {
            store[k] = Buffer.concat(parts.map(p => store.__parts[p.PartNumber])).toString('latin1'); delete store.__parts;
        },
        head: async k => ({ headers: { 'content-length': String(store[k].length) } }),
        putJson: async (k, o) => { calls.push(['put', k]); store[k] = JSON.stringify(o); },
        list: async p => Object.keys(store).filter(k => k.startsWith(p)),
        deleteMany: async keys => { calls.push(['delete', ...keys]); for (const k of keys) delete store[k]; },
    };
}

const quiet = () => {};

test('上传顺序：包→manifest→latest 最后写，latest 内容正确', async () => {
    const f = fixture(); const c = fakeClient();
    const latest = await run(parseArgs(['--pack', f.pack, '--manifest', f.manifest]), c, quiet);
    assert.deepEqual(c.calls.map(x => x[1]), [
        'fulltext/20261018-0100/fulltext-20261018-0100.tar.gz', 'fulltext/20261018-0100/manifest.json', 'fulltext/latest.json']);
    assert.equal(latest.packBytes, 1234);
    assert.match(latest.packSha256, /^[0-9a-f]{64}$/);
    assert.equal(JSON.parse(c.store['fulltext/latest.json']).stamp, '20261018-0100');
});

test('线上 latest 更新时拒绝覆盖（退出码 5），什么都不写', async () => {
    const f = fixture();
    const c = fakeClient({ 'fulltext/latest.json': JSON.stringify({ stamp: '20261019-0000', createdAtEpoch: 3000 }) });
    await assert.rejects(run(parseArgs(['--pack', f.pack, '--manifest', f.manifest]), c, quiet), e => e.code === 5);
    assert.equal(c.calls.length, 0);
});

test('上传后大小不符 → 退出码 6，不翻指针', async () => {
    const f = fixture(); const c = fakeClient();
    c.head = async () => ({ headers: { 'content-length': '1' } });
    await assert.rejects(run(parseArgs(['--pack', f.pack, '--manifest', f.manifest]), c, quiet), e => e.code === 6);
    assert.ok(!('fulltext/latest.json' in c.store));
});

test('只留最新 keep 个 stamp，旧的整目录删掉', async () => {
    const f = fixture();
    const c = fakeClient({
        'fulltext/20261001-0000/manifest.json': '{}', 'fulltext/20261001-0000/fulltext-20261001-0000.tar.gz': 'x',
        'fulltext/20261010-0000/manifest.json': '{}', 'fulltext/other.txt': 'keep',
    });
    await run(parseArgs(['--pack', f.pack, '--manifest', f.manifest, '--keep', '2']), c, quiet);
    assert.ok(!Object.keys(c.store).some(k => k.includes('20261001-0000')));
    assert.ok('fulltext/20261010-0000/manifest.json' in c.store && 'fulltext/other.txt' in c.store);
});

test('dry-run 不写任何东西', async () => {
    const f = fixture(); const c = fakeClient();
    await run(parseArgs(['--pack', f.pack, '--manifest', f.manifest, '--dry-run']), c, quiet);
    assert.equal(c.calls.length, 0);
});

test('manifest 校验：非 v2、partial、包名不符都拒', () => {
    assert.throws(() => checkManifest({ ...M, schemaVersion: 1 }, 'fulltext-20261018-0100.tar.gz'), e => e.code === 4);
    assert.throws(() => checkManifest({ ...M, partial: true }, 'fulltext-20261018-0100.tar.gz'), e => e.code === 4);
    assert.throws(() => checkManifest(M, 'fulltext-20261017-0100.tar.gz'), e => e.code === 4);
    checkManifest(M, 'fulltext-20261018-0100.tar.gz');
});

test('参数：缺包、坏 keep、坏前缀都报 2', () => {
    assert.throws(() => parseArgs(['--manifest', 'm']), e => e.code === 2);
    assert.throws(() => parseArgs(['--pack', 'p', '--manifest', 'm', '--keep', '0']), e => e.code === 2);
    assert.throws(() => parseArgs(['--pack', 'p', '--manifest', 'm', '--prefix', '../x']), e => e.code === 2);
    assert.equal(parseArgs(['--pack', 'p', '--manifest', 'm', '--prefix', '/staging/fulltext/']).prefix, 'staging/fulltext');
});

test('stampsToPrune 保护 latest 指向的版本', () => {
    const keys = ['f/20260101-0000/a', 'f/20260201-0000/a', 'f/20260301-0000/a'];
    assert.deepEqual(stampsToPrune(keys, 'f', 1, ['20260101-0000']), ['20260201-0000']);
});

test('wrapClient：网络错误重试，404 不重试', async () => {
    let n = 0;
    const cos = {
        putObject: (p, cb) => (++n < 3 ? cb({ message: 'socket hang up' }) : cb(null, {})),
        getObject: (p, cb) => cb({ statusCode: 404, message: 'NoSuchKey' }),
    };
    const c = wrapClient(cos, { bucket: 'b', region: 'r', sleep: async () => {} });
    await c.putJson('k', {}, 'no-cache');
    assert.equal(n, 3);
    assert.equal(await c.getJson('k'), null);
});

const md5 = b => createHash('md5').update(b).digest('hex');

function bigFile(size) {
    const d = mkdtempSync(join(tmpdir(), 'ftbig-'));
    const p = join(d, 'pack'); const buf = Buffer.alloc(size);
    for (let i = 0; i < size; i++) buf[i] = (i * 31 + 7) & 255;
    writeFileSync(p, buf);
    return { p, buf };
}

function mpClient({ failTimes = {}, existing = null, err = { message: 'User network is too slow.', code: 'UserNetworkTooSlow' } } = {}) {
    const parts = {}; const tries = {}; const log = { put: [], completed: null, inited: 0 };
    return {
        parts, tries, log,
        mpFind: async () => existing?.uploadId ?? null,
        mpInit: async () => { log.inited++; return 'NEW'; },
        mpParts: async () => existing?.parts ?? [],
        mpPut: async (k, u, i, buf) => {
            tries[i] = (tries[i] || 0) + 1;
            if (tries[i] <= (failTimes[i] || 0)) throw err;
            log.put.push(i); parts[i] = Buffer.from(buf); return `"${md5(buf)}"`;
        },
        mpComplete: async (k, u, ps) => { log.completed = { u, ps }; },
    };
}

test('uploadLarge：单块 UserNetworkTooSlow 只重传该块，最后按序合并', async () => {
    const { p, buf } = bigFile(10 * 1024 + 5);
    const c = mpClient({ failTimes: { 3: 2 } });
    await uploadLarge(c, 'k', p, buf.length, { partSize: 1024, parallel: 3, log: quiet, sleep: async () => {} });
    assert.equal(c.tries[3], 3);
    assert.equal(c.log.completed.ps.length, 11);
    assert.deepEqual(c.log.completed.ps.map(x => x.PartNumber), [...Array(11).keys()].map(i => i + 1));
    assert.ok(Buffer.concat(c.log.completed.ps.map(x => c.parts[x.PartNumber])).equals(buf));
});

test('uploadLarge：续传只补缺的块，MD5 不符的重传', async () => {
    const { p, buf } = bigFile(4096);
    const part = i => buf.subarray((i - 1) * 1024, i * 1024);
    const existing = { uploadId: 'OLD', parts: [
        { PartNumber: 1, ETag: `"${md5(part(1))}"`, Size: 1024 },
        { PartNumber: 2, ETag: '"deadbeef"', Size: 1024 },
        { PartNumber: 4, ETag: `"${md5(part(4))}"`, Size: 1024 } ] };
    const c = mpClient({ existing });
    await uploadLarge(c, 'k', p, buf.length, { partSize: 1024, parallel: 2, log: quiet, sleep: async () => {} });
    assert.equal(c.log.inited, 0);
    assert.deepEqual(c.log.put.sort(), [2, 3]);
    assert.equal(c.log.completed.u, 'OLD');
    assert.equal(c.log.completed.ps.length, 4);
});

test('uploadLarge：非网络错误立刻失败（退出码 6），不合并', async () => {
    const { p, buf } = bigFile(3000);
    const c = mpClient({ failTimes: { 2: 99 }, err: { statusCode: 403, message: 'AccessDenied' } });
    await assert.rejects(uploadLarge(c, 'k', p, buf.length, { partSize: 1024, log: quiet, sleep: async () => {} }), e => e.code === 6);
    assert.equal(c.tries[2], 1);
    assert.equal(c.log.completed, null);
});

test('uploadLarge：一块一直慢，试满 partTries 次后失败', async () => {
    const { p, buf } = bigFile(2048);
    const c = mpClient({ failTimes: { 1: 99 } });
    await assert.rejects(uploadLarge(c, 'k', p, buf.length, { partSize: 1024, partTries: 4, log: quiet, sleep: async () => {} }),
                         e => e.code === 6 && /第 1 块/.test(e.message));
    assert.equal(c.tries[1], 4);
});

test('isTransient 认得 UserNetworkTooSlow、5xx，不认 403', () => {
    assert.ok(isTransient({ message: 'User network is too slow.' }));
    assert.ok(isTransient({ error: { Code: 'UserNetworkTooSlow' } }));
    assert.ok(isTransient({ statusCode: 503 }));
    assert.ok(!isTransient({ statusCode: 403, message: 'AccessDenied' }));
});

test('onStray 只吞游离的 socket 错误', () => {
    assert.ok(onStray({ code: 'EPIPE', message: 'write EPIPE' }, quiet));
    assert.ok(onStray({ code: 'ECONNRESET' }, quiet));
    assert.ok(!onStray(new TypeError('x is undefined'), quiet));
});
