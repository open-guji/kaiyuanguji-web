import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spriteRefs, unregistered, runProofingSmoke } from './proofing-smoke.mjs';

const doc = {
    rev: '004-r6',
    sprites: [{ name: 'p0003.ab.webp' }],
    cells: [{ cell: '1:1:1', img: { s: 'p0003.ab.webp' }, alt: [{ c: '己', g: { s: 'alt-004.webp' } }, { c: '已' }] }],
};

test('引用了没登记的图', () => {
    assert.deepEqual([...spriteRefs(doc)].sort(), ['alt-004.webp', 'p0003.ab.webp']);
    assert.deepEqual(unregistered(doc), ['alt-004.webp']);
    assert.deepEqual(unregistered({ cells: [{ cell: '1:1:1' }] }), []);
});

test('冒烟：rev 不一致、未登记、图取不到都报出来；空单不看', async () => {
    const files = {
        'B/proof/index.json': { books: { bk: { '004': { rev: '004-r6', n: 1 }, '005': { rev: '005-r6', n: 10 }, '001': { rev: '001-r2', n: 0 } } } },
        'B/proof/bk/004.pending.json': doc,
        'B/proof/bk/005.pending.json': { rev: '005-r5', cells: [], sprites: [] },
    };
    const ok200 = new Set(['B/proof/bk/004/p0003.ab.webp']);
    const fetchFn = async (url, { range }) => {
        if (range) return { ok: ok200.has(url), status: ok200.has(url) ? 200 : 404 };
        const body = files[url];
        return body ? { ok: true, status: 200, json: async () => body } : { ok: false, status: 404 };
    };
    const r = await runProofingSmoke({ base: 'B', fetchFn });
    assert.equal(r.lists, 2);
    assert.equal(r.images, 2);
    assert.deepEqual(r.problems.sort(), [
        'bk/004：alt-004.webp 404',
        'bk/004：alt-004.webp 被引用但没登记进 sprites[]',
        'bk/005：单子 rev 005-r5 ≠ index 005-r6（CDN 旧缓存？）',
    ]);
});
