/** 用法：node --test scripts/lib/sprites-sync.test.mjs */
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyVolume, planUpload, parsePointerPath, checkPointer, sha256 } from './sprites-sync.mjs';

function make(over = {}) {
    const blobs = { 'sprites/a.webp': Buffer.from('aaa'), 'sprites/b.webp': Buffer.from('bbbb') };
    const m = { total: 2, files: Object.entries(blobs).map(([path, b]) => ({ path, bytes: b.length, sha256: sha256(b) })), ...over.manifest };
    const mbuf = Buffer.from(JSON.stringify(m));
    const files = { ...blobs, ...over.files };
    const src = {
        fetchManifest: async () => mbuf,
        fetchFile: async (_t, p) => { if (!(p in files)) throw new Error('404'); return files[p]; },
    };
    return { pointer: { tag: 't1', manifest_sha256: sha256(mbuf), ...over.pointer }, src };
}

test('好册通过，返回全部文件', async () => {
    const { pointer, src } = make();
    const r = await verifyVolume(pointer, src);
    assert.equal(r.ok, true);
    assert.deepEqual(r.files.map((f) => f.path), ['sprites/a.webp', 'sprites/b.webp']);
});

test('manifest sha256 与指针不符 → 不过，且不取文件', async () => {
    const { pointer, src } = make({ pointer: { manifest_sha256: '0'.repeat(64) } });
    let fetched = 0; const f0 = src.fetchFile; src.fetchFile = async (...a) => { fetched++; return f0(...a); };
    const r = await verifyVolume(pointer, src);
    assert.equal(r.ok, false); assert.equal(fetched, 0);
});

test('某个文件内容被改 → 整册不过', async () => {
    const { pointer, src } = make({ files: { 'sprites/b.webp': Buffer.from('bbbX') } });
    const r = await verifyVolume(pointer, src);
    assert.equal(r.ok, false); assert.equal(r.files.length, 0);
    assert.match(r.problems.join(), /b\.webp sha256 不符/);
});

test('字节数不符、缺文件、total 不符 都不过', async () => {
    assert.equal((await verifyVolume(...Object.values(make({ files: { 'sprites/a.webp': Buffer.from('aa') } })))).ok, false);
    const m = make(); m.src.fetchFile = async () => { throw new Error('404'); };
    assert.equal((await verifyVolume(m.pointer, m.src)).ok, false);
    assert.equal((await verifyVolume(...Object.values(make({ manifest: { total: 3 } })))).ok, false);
});

test('路径穿越／非 webp／重复 → 不过', async () => {
    for (const path of ['../x.webp', '/abs.webp', 'a/b.png']) {
        const b = Buffer.from('z');
        const { pointer, src } = make({ manifest: { total: 1, files: [{ path, bytes: 1, sha256: sha256(b) }] } });
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
    const files = [{ path: 'sprites/a.webp', sha256: 'h1' }, { path: 'sprites/b.webp', sha256: 'h2' }];
    const state = new Map([['proof/b/v/sprites/a.webp', 'h1'], ['proof/b/v/sprites/b.webp', 'old']]);
    const p = planUpload('', 'b', 'v', files, state);
    assert.deepEqual(p.skip.map((x) => x.path), ['sprites/a.webp']);
    assert.deepEqual(p.upload.map((x) => x.key), ['proof/b/v/sprites/b.webp']);
    assert.equal(planUpload('staging', 'b', 'v', files, new Map()).upload[0].key, 'staging/proof/b/v/sprites/a.webp');
});
