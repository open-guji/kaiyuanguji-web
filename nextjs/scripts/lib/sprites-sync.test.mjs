/** 用法：node --test scripts/lib/sprites-sync.test.mjs */
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyVolume, planUpload, parsePointerPath, checkPointer, sha256 } from './sprites-sync.mjs';

function make(over = {}) {
    const blobs = { 'a.webp': Buffer.from('aaa'), 'b.webp': Buffer.from('bbbb') };
    const m = { schema: 'guji-proof-assets/0.1', book: 'bk', volume: 1, rev: 'r2', files: Object.entries(blobs).map(([name, b]) => ({ name, bytes: b.length, sha256: sha256(b), w: 1, h: 1 })), ...over.manifest };
    const mbuf = over.raw ?? Buffer.from(JSON.stringify(m));
    const files = { ...blobs, ...over.files };
    const src = {
        fetchManifest: async () => mbuf,
        fetchFile: async (_t, p) => { if (!(p in files)) throw new Error('404'); return files[p]; },
    };
    return { pointer: { tag: 't1', manifest_sha256: sha256(mbuf), rev: 'r2', ...over.pointer }, src };
}

test('好册通过，返回全部文件', async () => {
    const { pointer, src } = make();
    const r = await verifyVolume(pointer, src);
    assert.equal(r.ok, true);
    assert.deepEqual(r.files.map((f) => f.name), ['a.webp', 'b.webp']);
});

test('manifest sha256 与指针不符 → 不过，且不取文件', async () => {
    const { pointer, src } = make({ pointer: { manifest_sha256: '0'.repeat(64) } });
    let fetched = 0; const f0 = src.fetchFile; src.fetchFile = async (...a) => { fetched++; return f0(...a); };
    const r = await verifyVolume(pointer, src);
    assert.equal(r.ok, false); assert.equal(fetched, 0);
});

test('某个文件内容被改 → 整册不过', async () => {
    const { pointer, src } = make({ files: { 'b.webp': Buffer.from('bbbX') } });
    const r = await verifyVolume(pointer, src);
    assert.equal(r.ok, false); assert.equal(r.files.length, 0);
    assert.match(r.problems.join(), /b\.webp sha256 不符/);
});

test('字节数不符、缺文件、total 不符 都不过', async () => {
    assert.equal((await verifyVolume(...Object.values(make({ files: { 'a.webp': Buffer.from('aa') } })))).ok, false);
    const m = make(); m.src.fetchFile = async () => { throw new Error('404'); };
    assert.equal((await verifyVolume(m.pointer, m.src)).ok, false);
    assert.equal((await verifyVolume(...Object.values(make({ manifest: { total: 3 } })))).ok, false);
});

test('路径穿越／非 webp／重复 → 不过', async () => {
    for (const path of ['../x.webp', '/abs.webp', 'a/b.png', 'sub/a.webp', '.hidden.webp']) {
        const b = Buffer.from('z');
        const { pointer, src } = make({ manifest: { files: [{ name: path, bytes: 1, sha256: sha256(b) }] } });
        assert.equal((await verifyVolume(pointer, src)).ok, false, path);
    }
});

test('指针校验与路径解析', () => {
    assert.deepEqual(parsePointerPath('proof/b1/v01/sprites.pointer.json'), { book: 'b1', vol: 'v01' });
    assert.equal(parsePointerPath('proof/b1/v01/pending.json'), null);
    assert.ok(checkPointer({ tag: 't', manifest_sha256: 'xx' }).length);
    assert.deepEqual(checkPointer({ tag: 't', manifest_sha256: 'a'.repeat(64) }), []);
});

test('上传计划：state 里 sha 相同的跳过，前缀可空', () => {
    const files = [{ name: 'a.webp', sha256: 'h1' }, { name: 'b.webp', sha256: 'h2' }];
    const state = new Map([['proof/b/v/a.webp', 'h1'], ['proof/b/v/b.webp', 'old']]);
    const p = planUpload('', 'b', 'v', files, state);
    assert.deepEqual(p.skip.map((x) => x.name), ['a.webp']);
    assert.deepEqual(p.upload.map((x) => x.key), ['proof/b/v/b.webp']);
    assert.equal(planUpload('staging', 'b', 'v', files, new Map()).upload[0].key, 'staging/proof/b/v/a.webp');
});

test('没有 total 也行；带了 total 则须相等', async () => {
    assert.equal((await verifyVolume(...Object.values(make()))).ok, true);
    assert.equal((await verifyVolume(...Object.values(make({ manifest: { total: 2 } })))).ok, true);
});

test('清单与指针／所在目录交叉核对：rev、book、volume、schema', async () => {
    const ok = make();
    assert.equal((await verifyVolume(ok.pointer, ok.src, { book: 'bk', vol: '001' })).ok, true);
    assert.equal((await verifyVolume(ok.pointer, ok.src, { book: 'other', vol: '001' })).ok, false);
    assert.equal((await verifyVolume(ok.pointer, ok.src, { book: 'bk', vol: '002' })).ok, false);
    const r = make({ pointer: { rev: 'r9' } });
    assert.match((await verifyVolume(r.pointer, r.src)).problems.join(), /rev/);
    const sc = make({ manifest: { schema: 'x/1' } });
    assert.equal((await verifyVolume(sc.pointer, sc.src)).ok, false);
});

test('清单是 null／数组／空文件列表 → 不抛错，进 problems', async () => {
    for (const raw of ['null', '[]', '"x"']) {
        const { pointer, src } = make({ raw: Buffer.from(raw) });
        const r = await verifyVolume(pointer, src);
        assert.equal(r.ok, false, raw); assert.ok(r.problems.length);
    }
    const e = make({ manifest: { files: [] } });
    assert.equal((await verifyVolume(e.pointer, e.src)).ok, false);
});

test('tag 为 . 或 .. 被拒', () => {
    for (const tag of ['.', '..']) assert.ok(checkPointer({ tag, manifest_sha256: 'a'.repeat(64) }).length, tag);
});
