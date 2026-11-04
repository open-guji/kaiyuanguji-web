import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSummaries, clusterKey, cellReason, clusterChar } from './proofing-summary.mjs';

const mk = (cells) => JSON.stringify({ rev: 'r1', cells });
const entries = [
    { book: 'bk01', chap: '021', rev: 'r21', n: 3, text: mk([
        { a: '1:1:1', pending_reason: 'lib_missing', ref: { c: '兀' }, c: '亣' },
        { a: '1:1:2', pending_reason: 'lib_missing', ref: { c: '兀' } },
        { a: '1:1:3', pending_reason: 'hard_pair', c: '日' },
    ]) },
    { book: 'bk01', chap: '020', rev: 'r20', n: 2, text: mk([
        { a: '2:1:1', pending_reason: 'lib_missing', ref: { c: '兀' } },
        { a: '2:1:2' },
    ]) },
    { book: 'bk02', chap: '001', rev: 'r1', n: 0, text: mk([]) },
];

test('clusterKey：原因＋整理本字，缺省退机器字，认不出原因为 unknown', () => {
    assert.equal(clusterKey({ pending_reason: 'lib_missing', ref: { c: '兀' }, c: 'x' }), 'lib_missing~兀');
    assert.equal(clusterKey({ pending_reason: 'hard_pair', c: '日' }), 'hard_pair~日');
    assert.equal(clusterKey({}), 'unknown~');
    assert.equal(cellReason({ pending_reason: 'BAD value!' }), 'unknown');
    assert.equal(clusterChar({ ref: { c: '兀兀' }, c: '亣' }), '亣');
});

test('buildSummaries：每章分原因计数，聚类跨章合并并按格数排序', () => {
    const m = buildSummaries(entries, { voted: new Map([['bk01\u0000r21', 2]]) });
    assert.deepEqual([...m.keys()], ['bk01', 'bk02']);
    const s = JSON.parse(m.get('bk01'));
    assert.deepEqual(Object.keys(s.chaps), ['020', '021']);
    assert.deepEqual(s.chaps['021'], { rev: 'r21', n: 3, reasons: { hard_pair: 1, lib_missing: 2 }, voted: 2 });
    assert.equal(s.chaps['020'].voted, undefined);
    assert.equal(s.clusters[0].k, 'lib_missing~兀');
    assert.equal(s.clusters[0].n, 3);
    assert.deepEqual(s.clusters[0].chaps, { '020': 1, '021': 2 });
});

test('buildSummaries：同输入同字节；坏单只记 n', () => {
    const a = buildSummaries(entries);
    const b = buildSummaries([...entries].reverse());
    assert.equal(a.get('bk01'), b.get('bk01'));
    const bad = buildSummaries([{ book: 'bk03', chap: '001', rev: 'r', n: 5, text: 'not json' }]);
    assert.deepEqual(JSON.parse(bad.get('bk03')).chaps['001'], { rev: 'r', n: 5, reasons: {} });
});
