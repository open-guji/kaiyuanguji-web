import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookIdOfPath, bookVersionShardKey, computeBookVersions, buildBookVersionShards, bookVersionShardPath } from './book-versions.mjs';

const md5 = (m) => (rel) => m[rel] ?? 'x';

test('bookIdOfPath：只认 items/<id>/ 下的文件', () => {
    assert.equal(bookIdOfPath('items/abc123xy/default/001.txt'), 'abc123xy');
    assert.equal(bookIdOfPath('items/abc123xy/manifest.json'), 'abc123xy');
    assert.equal(bookIdOfPath('entry/abc123xy.json'), null);
    assert.equal(bookIdOfPath('promotions.json'), null);
});

test('bookVersionShardKey：末 2 位；太短或含非法字符为 null', () => {
    assert.equal(bookVersionShardKey('abc123xy'), 'xy');
    assert.equal(bookVersionShardKey('a'), null);
    assert.equal(bookVersionShardKey('ab/cd'), null);
});

const files = [
    { relative: 'items/aaaa11/manifest.json' },
    { relative: 'items/aaaa11/default/001.txt' },
    { relative: 'items/bbbb22/manifest.json' },
    { relative: 'entry/aaaa11.json' },
];

test('只改一本书：另一本的版本不变，被改的变', () => {
    const m0 = { 'items/aaaa11/manifest.json': '1', 'items/aaaa11/default/001.txt': '2', 'items/bbbb22/manifest.json': '3' };
    const v0 = computeBookVersions(files, md5(m0));
    const v1 = computeBookVersions(files, md5({ ...m0, 'items/aaaa11/default/001.txt': '9' }));
    assert.equal(v1.get('bbbb22'), v0.get('bbbb22'));
    assert.notEqual(v1.get('aaaa11'), v0.get('aaaa11'));
    assert.match(v0.get('aaaa11'), /^[0-9a-f]{16}$/);
    assert.equal(v0.size, 2); // entry/ 不算书内文件
});

test('与遍历顺序、其它书的改动无关；回滚内容回到旧版本', () => {
    const m = { 'items/aaaa11/manifest.json': '1', 'items/aaaa11/default/001.txt': '2', 'items/bbbb22/manifest.json': '3' };
    const a = computeBookVersions(files, md5(m));
    const b = computeBookVersions([...files].reverse(), md5(m));
    assert.deepEqual([...a], [...b].sort());
    const changed = computeBookVersions(files, md5({ ...m, 'items/aaaa11/manifest.json': '7' }));
    const back = computeBookVersions(files, md5(m));
    assert.equal(back.get('aaaa11'), a.get('aaaa11'));
    assert.notEqual(changed.get('aaaa11'), a.get('aaaa11'));
});

test('文件改名（内容相同）也算变；新增文件算变', () => {
    const base = computeBookVersions([{ relative: 'items/aaaa11/a.txt' }], md5({}));
    const renamed = computeBookVersions([{ relative: 'items/aaaa11/b.txt' }], md5({}));
    const added = computeBookVersions([{ relative: 'items/aaaa11/a.txt' }, { relative: 'items/aaaa11/b.txt' }], md5({}));
    assert.notEqual(base.get('aaaa11'), renamed.get('aaaa11'));
    assert.notEqual(base.get('aaaa11'), added.get('aaaa11'));
});

test('分片：按末 2 位分，确定性输出（逐字节一致），短 ID 不进清单', () => {
    const v = new Map([['aaaa11', 'a'.repeat(16)], ['bbbb22', 'b'.repeat(16)], ['cccc11', 'c'.repeat(16)], ['x', 'd'.repeat(16)]]);
    const s1 = buildBookVersionShards(v);
    const s2 = buildBookVersionShards(new Map([...v].reverse()));
    assert.deepEqual([...s1], [...s2]);
    assert.deepEqual([...s1.keys()], ['11', '22']);
    const doc = JSON.parse(s1.get('11'));
    assert.deepEqual(doc, { version: 1, books: { aaaa11: { v: 'a'.repeat(16) }, cccc11: { v: 'c'.repeat(16) } } });
    assert.equal(bookVersionShardPath('11'), 'vers/11.json');
});
