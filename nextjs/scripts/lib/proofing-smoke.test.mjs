import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spriteRefs, runProofingSmoke } from './proofing-smoke.mjs';

const doc = {
    cells: [{ cell: '1:1:1', img: { s: 'p0003.ab.webp' }, alt: [{ c: '己', g: { s: 'alt-004.webp' } }, { c: '已' }] }],
};

test('引用的图名：格的 img.s 与相似字的 alt[].g.s', () => {
    assert.deepEqual([...spriteRefs(doc)].sort(), ['alt-004.webp', 'p0003.ab.webp']);
    assert.deepEqual([...spriteRefs({ cells: [{ cell: '1:1:1' }] })], []);
});

const mk = (files, ok200 = new Set()) => async (url, { range }) => {
    if (range) return { ok: ok200.has(url), status: ok200.has(url) ? 200 : 404 };
    const body = files[url];
    return body ? { ok: true, status: 200, json: async () => body } : { ok: false, status: 404 };
};

test('冒烟：待审格取不到、图取不到都报出来；空章不看；没有 rev 的检查', async () => {
    const files = {
        'B/proof/index.json': { books: { bk: { '004': { n: 1 }, '005': { n: 10 }, '001': { n: 0 } } } },
        'S/api/pending?book=bk&vol=004': doc,
    };
    const r = await runProofingSmoke({ base: 'B', site: 'S', fetchFn: mk(files, new Set(['B/proof/bk/004/p0003.ab.webp'])) });
    assert.equal(r.lists, 1);
    assert.equal(r.images, 2);
    assert.deepEqual(r.problems.sort(), ['bk/004：alt-004.webp 404', 'bk/005 待审格 404']);
});

test('冒烟 only：范围外章节只告警、不查图、不算失败', async () => {
    const files = {
        'B/proof/index.json': { books: { bk: { '004': { n: 1 }, '005': { n: 10 } } } },
        'S/api/pending?book=bk&vol=004': doc,
    };
    const seen = [];
    const fetchFn = async (url, o) => { if (o.range) seen.push(url); return mk(files, new Set(seen))(url, o); };
    const r = await runProofingSmoke({ base: 'B', site: 'S', fetchFn, only: (e) => e.chap === '004' });
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.warnings, ['bk/005 待审格 404']);
    assert.equal(r.images, 2);
});

test('冒烟：index.json 取不到就是问题', async () => {
    const r = await runProofingSmoke({ base: 'B', site: 'S', fetchFn: mk({}) });
    assert.deepEqual(r.problems, ['proof/index.json 404']);
});
