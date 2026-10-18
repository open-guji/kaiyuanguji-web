// upload_cos.mjs 单测（假 COS 客户端，不连网）。运行：node --test fulltext/build/tests/
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkManifest, parseArgs, run, stampsToPrune, wrapClient } from '../upload_cos.mjs';

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
        uploadFile: async (k, path) => { calls.push(['upload', k]); store[k] = 'x'.repeat(1234); },
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
