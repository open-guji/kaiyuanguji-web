#!/usr/bin/env node
/**
 * derived.test.mjs — schema-v2 build 产物读取层（lib/derived.mjs，overview#458）单测。
 * 用法：node scripts/lib/derived.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { classificationOf, derivedDir, derivedPath, indexDirFor, readEntryDoc, taxonomyFileFor } from './derived.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'derived-'));
try {
    const prod = join(tmp, 'prod');
    const der = join(tmp, 'der');
    mkdirSync(join(prod, 'Work'), { recursive: true });
    mkdirSync(join(der, 'entry'), { recursive: true });
    writeFileSync(join(prod, 'Work', 'a.json'), JSON.stringify({ id: 'a', title: '源' }));
    writeFileSync(join(prod, 'Work', 'b.json'), JSON.stringify({ id: 'b', title: '只在源' }));
    writeFileSync(join(der, 'entry', 'a.json'), JSON.stringify({ id: 'a', title: '源', _books: [{ id: 'x' }] }));

    // 没设环境变量：旧路径
    assert.equal(derivedDir({}), null);
    assert.equal(derivedDir({ BOOK_INDEX_DERIVED_DIR: '  ' }), null);
    assert.equal(derivedDir({ BOOK_INDEX_DERIVED_DIR: der }), der);
    assert.equal(readEntryDoc({ id: 'a', srcPath: join(prod, 'Work', 'a.json'), dir: null }).derived, false);
    assert.equal(readEntryDoc({ id: 'a', srcPath: join(prod, 'Work', 'a.json'), dir: null }).doc._books, undefined);

    // 设了：产物优先，缺则回退源档，都没有返回 null
    const hit = readEntryDoc({ id: 'a', srcPath: join(prod, 'Work', 'a.json'), dir: der });
    assert.equal(hit.derived, true);
    assert.deepEqual(hit.doc._books, [{ id: 'x' }]);
    const fb = readEntryDoc({ id: 'b', srcPath: join(prod, 'Work', 'b.json'), dir: der });
    assert.equal(fb.derived, false);
    assert.equal(fb.doc.title, '只在源');
    assert.equal(readEntryDoc({ id: 'c', srcPath: join(prod, 'Work', 'c.json'), dir: der }), null);

    // index／classific：产物里有才用
    assert.equal(indexDirFor(prod, der), join(prod, 'index'));
    mkdirSync(join(der, 'index'));
    assert.equal(indexDirFor(prod, der), join(der, 'index'));
    assert.equal(taxonomyFileFor(prod, der), join(prod, 'classific.json'));
    writeFileSync(join(der, 'classific.json'), '{}');
    assert.equal(taxonomyFileFor(prod, der), join(der, 'classific.json'));
    assert.equal(derivedPath('nope.json', der), null);
    assert.equal(derivedPath('classific.json', null), null);

    // 分类：新字段优先（zongmu），回退旧字段，都没有 null
    assert.deepEqual(
        classificationOf({ classification: { l1: '舊' }, _classifications: [{ scheme: 'other', l1: '乙', l2: '' }, { scheme: 'zongmu', l1: '史部', l2: '雜史類', l3: '', l4: '', source: '總目' }] }),
        { l1: '史部', l2: '雜史類', l3: '', l4: '', source: '總目' },
    );
    assert.deepEqual(classificationOf({ _classifications: [{ scheme: 'x', l1: '丙', l2: '丁' }] }), { l1: '丙', l2: '丁', l3: '', l4: '' });
    assert.deepEqual(classificationOf({ classification: { l1: '經部', l2: '易類' } }), { l1: '經部', l2: '易類' });
    assert.equal(classificationOf({ _classifications: [] }), null);
    assert.equal(classificationOf({}), null);
    console.log('derived.test.mjs ✓');
} finally {
    rmSync(tmp, { recursive: true, force: true });
}
