import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { uploadVolume, IMMUTABLE_CACHE } from './sprites-upload.mjs';

const runQueue = async (items, _c, fn) => { for (const i of items) await fn(i); };
const mk = (n) => Array.from({ length: n }, (_, i) => ({ key: `staging/proof/b/001/p000${i}.webp`, buf: Buffer.from(`x${i}`) }));
const base = () => {
    const puts = [], logs = [];
    return { puts, logs, tmpDir: mkdtempSync(join(tmpdir(), 'su-')), runQueue, log: (m) => logs.push(m),
        cosOps: { uploadOne: async (f, key, cc, ct) => { puts.push({ key, cc, ct }); } } };
};

test('全新：全部 PUT（immutable、image/webp），HEAD 核 3 个', async () => {
    const b = base(), heads = [];
    const r = await uploadVolume({ id: 'b/001', files: mk(5), remote: new Map(), ...b, headLen: async (k) => { heads.push(k); return Buffer.byteLength('x0'); } });
    assert.deepEqual([r.put, r.same, r.failed, r.headBad], [5, 0, 0, 0]);
    assert.equal(b.puts[0].cc, IMMUTABLE_CACHE); assert.equal(b.puts[0].ct, 'image/webp');
    assert.equal(heads.length, 3);
});

test('COS 上 md5 相同的跳过', async () => {
    const b = base(), files = mk(2);
    const remote = new Map([[files[0].key, createHash('md5').update(files[0].buf).digest('hex')]]);
    const r = await uploadVolume({ id: 'b/001', files, remote, ...b, headLen: async () => 2 });
    assert.deepEqual([r.put, r.same], [1, 1]);
});

test('上传失败只警告、不抛、不做 HEAD', async () => {
    const b = base(); let h = 0;
    b.cosOps.uploadOne = async () => { throw new Error('boom'); };
    const r = await uploadVolume({ id: 'b/001', files: mk(2), remote: new Map(), ...b, headLen: async () => { h++; return 0; } });
    assert.equal(r.failed, 2); assert.equal(h, 0);
    assert.ok(b.logs.every((l) => l.startsWith('::warning::')));
});

test('HEAD 长度不符 / HEAD 失败：计 headBad 并警告', async () => {
    const b = base();
    let n = 0;
    const r = await uploadVolume({ id: 'b/001', files: mk(3), remote: new Map(), ...b, headLen: async () => { if (n++ === 0) throw new Error('404'); return 999; } });
    assert.equal(r.headBad, 3); assert.equal(b.logs.length, 3);
});
