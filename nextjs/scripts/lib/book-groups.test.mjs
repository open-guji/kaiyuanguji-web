import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { syncBookGroupPages, bookGroupPagePath } from './book-groups.mjs';

function setup() {
    const root = mkdtempSync(join(tmpdir(), 'bg-'));
    const src = join(root, 'books'), dest = join(root, 'out', 'book-groups');
    mkdirSync(join(src, 'w1', 'cA'), { recursive: true });
    mkdirSync(join(src, 'w1', '_none'), { recursive: true });
    writeFileSync(join(src, 'w1', 'cA', '1.json'), JSON.stringify([{ id: 'b1' }]));
    writeFileSync(join(src, 'w1', 'cA', '2.json'), JSON.stringify([{ id: 'b2' }]));
    writeFileSync(join(src, 'w1', '_none', '1.json'), JSON.stringify([{ id: 'b3' }]));
    return { src, dest };
}

test('拷贝分页、第二次不重写、删掉产物里没有的旧文件', () => {
    const { src, dest } = setup();
    assert.deepEqual(syncBookGroupPages(src, dest), { works: 1, files: 3, written: 3, removed: 0 });
    assert.deepEqual(JSON.parse(readFileSync(join(dest, 'w1', 'cA', '2.json'), 'utf-8')), [{ id: 'b2' }]);
    assert.deepEqual(syncBookGroupPages(src, dest), { works: 1, files: 3, written: 0, removed: 0 });
    mkdirSync(join(dest, 'w9', 'cZ'), { recursive: true });
    writeFileSync(join(dest, 'w9', 'cZ', '1.json'), '[]');
    assert.equal(syncBookGroupPages(src, dest).removed, 1);
    assert.equal(existsSync(join(dest, 'w9')), false);
});

test('产物没有 books/：清空目标', () => {
    const { src, dest } = setup();
    syncBookGroupPages(src, dest);
    assert.equal(syncBookGroupPages(null, dest).removed, 3);
    assert.equal(existsSync(dest), false);
});

test('不是数组就报错', () => {
    const { src, dest } = setup();
    writeFileSync(join(src, 'w1', 'cA', '1.json'), '{}');
    assert.throws(() => syncBookGroupPages(src, dest), /不是 Book 卡数组/);
});

test('bookGroupPagePath', () => {
    assert.equal(bookGroupPagePath('w1', '_none', 2), 'book-groups/w1/_none/2.json');
});
