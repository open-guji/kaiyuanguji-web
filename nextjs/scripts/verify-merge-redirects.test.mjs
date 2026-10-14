/**
 * verify-merge-redirects.test.mjs — 纯函数部分（不联网）。用法：node --test scripts/verify-merge-redirects.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadIndex, pickTombstones, workPageFor, parseVersionCount, locationIsKeeper } from './verify-merge-redirects.mjs';

function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'vmr-'));
    const put = (top, id, e) => { const d = join(root, top, id[0], id[1], id[2]); mkdirSync(d, { recursive: true }); writeFileSync(join(d, `${id}-x.json`), JSON.stringify({ id, ...e })); };
    put('Work', 'wkeeper00001', { type: 'work' });
    put('Work', 'wtomb0000001', { type: 'work', merged_into: 'wkeeper00001' });
    put('Book', 'bk0000000001', { type: 'book', work_id: 'wkeeper00001' });
    put('Book', 'bk0000000002', { type: 'book', work_id: 'wkeeper00001' });
    put('Book', 'bktomb000001', { type: 'book', work_id: 'wkeeper00001', merged_into: 'bk0000000001' });
    return loadIndex(root);
}

test('墓碑 Book 不计入版本数；Work 墓碑可被挑出', () => {
    const idx = fixture();
    assert.equal(idx.booksByWork.get('wkeeper00001'), 2);
    const { tombs } = pickTombstones(idx, { type: 'work' });
    assert.deepEqual(tombs.map((t) => t.id), ['wtomb0000001']);
    assert.deepEqual(pickTombstones(idx, { type: 'book' }).tombs.map((t) => t.id), ['bktomb000001']);
});

test('--ids：不存在、非墓碑要报问题', () => {
    const idx = fixture();
    const { tombs, problems } = pickTombstones(idx, { ids: ['wtomb0000001', 'nope00000000', 'wkeeper00001'] });
    assert.equal(tombs.length, 1); assert.equal(problems.length, 2);
});

test('keeper 是 Book 时取其 work_id；keeper 也是墓碑要报', () => {
    const idx = fixture();
    assert.deepEqual(workPageFor(idx, 'bk0000000001'), { workId: 'wkeeper00001' });
    assert.ok(workPageFor(idx, 'wtomb0000001').error);
    assert.ok(workPageFor(idx, 'zzzz').error);
});

test('页面版本数：描述句、截断、无句三种', () => {
    const ld = '"workExample":[{"@type":"Book","@id":"a"},{"@type":"Book","@id":"b"}]';
    assert.deepEqual(parseVersionCount(`<meta name="description" content="…本站收录其版本 2 种。"/>${ld}`), { text: 2, ld: 2 });
    assert.deepEqual(parseVersionCount(`<meta name="description" content="很长的简介…"/>${ld}`), { text: null, ld: 2 });
    assert.deepEqual(parseVersionCount(`<meta name="description" content="${'简'.repeat(150)}。"/>${ld}`), { text: null, ld: 2 });
    assert.deepEqual(parseVersionCount('<meta name="description" content="简介。"/>'), { text: 0, ld: 0 });
});

test('Location：相对／绝对／双值（"x, x"）', () => {
    assert.ok(locationIsKeeper('/item/abc', 'abc'));
    assert.ok(locationIsKeeper('https://www.openguji.com/item/abc/', 'abc'));
    assert.ok(!locationIsKeeper('/item/abc, /item/abc', 'abc'));
    assert.ok(!locationIsKeeper(null, 'abc'));
});
