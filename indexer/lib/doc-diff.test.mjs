import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson, docHash, diffHashes, changeRatio, deltaProblems, FALLBACK, writeJsonGz, readJsonGz } from './doc-diff.mjs';
import { diffDocs } from '../diff-docs.mjs';
import { readJsonlGz } from './ingest-support.mjs';

test('规范化 JSON 与键顺序无关、数组保序', () => {
    assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }));
    assert.notEqual(canonicalJson({ a: [1, 2] }), canonicalJson({ a: [2, 1] }));
    assert.equal(docHash({ id: 'x', t: '史記' }), docHash({ t: '史記', id: 'x' }));
    assert.notEqual(docHash({ id: 'x', t: '史記' }), docHash({ id: 'x', t: '史记' }));
    assert.match(docHash({ id: 'x' }), /^[0-9a-f]{16}$/);
});

test('两代哈希比对：新增、改动、删除、不变', () => {
    const d = diffHashes({ a: '1', b: '2', c: '3' }, new Map([['a', '1'], ['b', '9'], ['d', '4']]));
    assert.deepEqual([...d.upsert].sort(), ['b', 'd']);
    assert.deepEqual([...d.del], ['c']);
    assert.equal(d.added, 1); assert.equal(d.changed, 1); assert.equal(d.unchanged, 1);
    assert.equal(changeRatio(d, 3), 1);
    assert.equal(changeRatio(diffHashes({}, {}), 0), 0);
});

const goodDelta = () => ({ schema: 1, mode: 'incremental', indexerVersion: 'v1', renderRunId: '20', base: { renderRunId: '10' },
    expectedCounts: { works: 3 }, upserts: { works: 1 }, deletes: { works: 0 }, sha256: { works: 'a'.repeat(64) } });

test('差量只能打到它的基线那一代上', () => {
    assert.deepEqual(deltaProblems(goodDelta(), { renderRunId: '10', indexerVersion: 'v1' }), []);
    assert.ok(deltaProblems(goodDelta(), { renderRunId: '11', indexerVersion: 'v1' }).some((s) => s.includes('基线对不上')));
    assert.ok(deltaProblems(goodDelta(), null).some((s) => s.startsWith(FALLBACK.STATE_MISSING)));
    assert.ok(deltaProblems(goodDelta(), { indexerVersion: 'v1' }).some((s) => s.includes('renderRunId')), '旧版全量写的 state 没有 renderRunId');
    assert.ok(deltaProblems(goodDelta(), { renderRunId: '10', indexerVersion: 'v0' }).some((s) => s.startsWith(FALLBACK.VERSION)));
    const noSha = goodDelta(); delete noSha.sha256.works;
    assert.ok(deltaProblems(noSha, { renderRunId: '10' }).some((s) => s.includes('sha256.works')));
    const noUp = goodDelta(); noUp.upserts.works = 0; delete noUp.sha256.works;
    assert.deepEqual(deltaProblems(noUp, { renderRunId: '10' }), [], '没有 upsert 就不要求 sha256');
});

async function writeJsonl(path, docs) {
    const gz = createGzip(); const out = createWriteStream(path); gz.pipe(out);
    for (const d of docs) gz.write(JSON.stringify(d) + '\n');
    gz.end(); await once(out, 'finish');
}

/** 造一代 render-docs 产物：manifest＋docs＋hashes */
async function fakeRender(dir, runId, docsByIdx, { indexerVersion = 'v1' } = {}) {
    mkdirSync(join(dir, 'docs'), { recursive: true }); mkdirSync(join(dir, 'hashes'), { recursive: true });
    const counts = {};
    for (const [idx, docs] of Object.entries(docsByIdx)) {
        await writeJsonl(join(dir, 'docs', `${idx}.jsonl.gz`), docs);
        await writeJsonGz(join(dir, 'hashes', `${idx}.json.gz`), Object.fromEntries(docs.map((d) => [d.id, docHash(d)])));
        counts[idx] = docs.length;
    }
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ schema: 1, indexerVersion, renderRunId: runId, commits: { prod: runId }, counts,
        editionStats: { total: 1, present: 1, positive: 1 }, partial: false }));
}

test('diff-docs：挑出改动与新增的文档、列出删除的 id、manifest 指回基线', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dd-'));
    await fakeRender(join(root, 'base'), '10', { works: [{ id: 'a', t: 1 }, { id: 'b', t: 2 }, { id: 'c', t: 3 }], books: [{ id: 'x', t: 1 }] });
    await fakeRender(join(root, 'new'), '20', { works: [{ id: 'a', t: 1 }, { id: 'b', t: 9 }, { id: 'd', t: 4 }], books: [{ id: 'x', t: 1 }] });
    const r = await diffDocs({ newDir: join(root, 'new'), baseDir: join(root, 'base'), outDir: join(root, 'out'), maxRatio: 1 });
    const m = r.manifest;
    assert.equal(m.base.renderRunId, '10'); assert.equal(m.renderRunId, '20');
    assert.deepEqual(m.upserts, { works: 2, books: 0 });
    assert.deepEqual(m.deletes, { works: 1, books: 0 });
    assert.deepEqual(m.expectedCounts, { works: 3, books: 1 });
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'out', 'deletes', 'works.json'), 'utf-8')), ['c']);
    const got = [];
    const rr = await readJsonlGz(join(root, 'out', 'docs', 'works.jsonl.gz'), { onBatch: async (ds) => got.push(...ds) });
    assert.deepEqual(got.map((d) => d.id).sort(), ['b', 'd']);
    assert.equal(rr.sha256, m.sha256.works, 'manifest 里的 sha256 就是差量文件的');
    assert.ok(existsSync(join(root, 'out', 'manifest.json')));
});

test('diff-docs：没有基线、口径变了、变动过大都不走增量', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dd-'));
    await fakeRender(join(root, 'base'), '10', { works: [{ id: 'a', t: 1 }, { id: 'b', t: 2 }] });
    await fakeRender(join(root, 'new'), '20', { works: [{ id: 'a', t: 1 }, { id: 'b', t: 3 }] });
    await fakeRender(join(root, 'newv'), '21', { works: [{ id: 'a', t: 1 }, { id: 'b', t: 2 }] }, { indexerVersion: 'v2' });
    const out = join(root, 'o');
    assert.equal((await diffDocs({ newDir: join(root, 'new'), baseDir: join(root, 'nope'), outDir: out })).fallback, FALLBACK.BASE_MISSING);
    assert.equal((await diffDocs({ newDir: join(root, 'newv'), baseDir: join(root, 'base'), outDir: out })).fallback, FALLBACK.VERSION);
    assert.equal((await diffDocs({ newDir: join(root, 'new'), baseDir: join(root, 'base'), outDir: out, maxRatio: 0.3 })).fallback, FALLBACK.RATIO);
    assert.ok((await diffDocs({ newDir: join(root, 'new'), baseDir: join(root, 'base'), outDir: out, maxRatio: 0.3, allowHighRatio: true })).manifest);
});

test('哈希表读写往返', async () => {
    const p = join(mkdtempSync(join(tmpdir(), 'dd-')), 'h.json.gz');
    await writeJsonGz(p, { a: '1', 書: '2' });
    assert.deepEqual(await readJsonGz(p), { a: '1', 書: '2' });
});
