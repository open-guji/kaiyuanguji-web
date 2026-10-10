#!/usr/bin/env node
/**
 * derived.test.mjs — schema-v2 build 产物读取层（lib/derived.mjs，overview#458）单测。
 * 用法：node scripts/lib/derived.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
    classificationOf, derivedDir, derivedPath, entryReadStatsSnapshot, indexDirFor, readEntryDoc, reportEntryReads,
    resetEntryReadStats, summarizeEntryReads, taxonomyFileFor,
} from './derived.mjs';

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

    // 分类：只读 _classifications（优先 zongmu），旧 classification 不再读，都没有 null
    assert.deepEqual(
        classificationOf({ classification: { l1: '舊' }, _classifications: [{ scheme: 'other', l1: '乙', l2: '' }, { scheme: 'zongmu', l1: '史部', l2: '雜史類', l3: '', l4: '', source: '總目' }] }),
        { l1: '史部', l2: '雜史類', l3: '', l4: '', source: '總目' },
    );
    assert.deepEqual(classificationOf({ _classifications: [{ scheme: 'x', l1: '丙', l2: '丁' }] }), { l1: '丙', l2: '丁', l3: '', l4: '' });
    assert.equal(classificationOf({ classification: { l1: '經部', l2: '易類' } }), null);
    assert.equal(classificationOf({ _classifications: [] }), null);
    assert.equal(classificationOf({}), null);
    // 命中数闸：只数设了产物目录的读；回退>0 默认只警告，STRICT_DERIVED=1 才失败
    resetEntryReadStats();
    readEntryDoc({ id: 'a', srcPath: join(prod, 'Work', 'a.json'), dir: null, stat: 'x' }); // 旧路径不计
    assert.deepEqual(entryReadStatsSnapshot(), {});
    readEntryDoc({ id: 'a', srcPath: join(prod, 'Work', 'a.json'), dir: der, stat: 'catalog' });
    readEntryDoc({ id: 'b', srcPath: join(prod, 'Work', 'b.json'), dir: der, stat: 'catalog' });
    readEntryDoc({ id: 'a', srcPath: join(prod, 'Work', 'a.json'), dir: der, stat: 'read' });
    readEntryDoc({ id: 'c', srcPath: join(prod, 'Work', 'c.json'), dir: der, stat: 'read' });
    assert.deepEqual(entryReadStatsSnapshot(), {
        catalog: { hit: 1, fallback: 1, missing: 0 },
        read: { hit: 1, fallback: 0, missing: 1 },
    });
    const sumFile = join(tmp, 'summary.md');
    const logs = [];
    const warns = [];
    const io = { log: (s) => logs.push(s), warn: (s) => warns.push(s) };
    const r1 = reportEntryReads({ env: { BOOK_INDEX_DERIVED_DIR: der, GITHUB_STEP_SUMMARY: sumFile }, ...io });
    assert.equal(r1.enabled, true);
    assert.equal(r1.fallback, 1);
    assert.equal(r1.fail, false); // 默认不失败
    assert.equal(warns.length, 1);
    assert.ok(logs[0].includes('命中产物 2，回退源档 1'));
    assert.ok(readFileSync(sumFile, 'utf-8').includes('回退源档 1'));
    assert.equal(reportEntryReads({ env: { BOOK_INDEX_DERIVED_DIR: der, STRICT_DERIVED: '1' }, ...io }).fail, true);
    assert.equal(summarizeEntryReads({ BOOK_INDEX_DERIVED_DIR: der, STRICT_DERIVED: '0' }).fail, false);
    // 回退数为 0：strict 也不失败
    assert.equal(summarizeEntryReads({ BOOK_INDEX_DERIVED_DIR: der, STRICT_DERIVED: '1' }, { entry: { hit: 5, fallback: 0, missing: 0 } }).fail, false);
    // 没设产物目录：strict 也不判闸
    const r0 = summarizeEntryReads({ STRICT_DERIVED: '1' }, { entry: { hit: 0, fallback: 9, missing: 0 } });
    assert.equal(r0.enabled, false);
    assert.equal(r0.fail, false);
    assert.equal(r0.warnings.length, 0);
    resetEntryReadStats();
    console.log('derived.test.mjs ✓');
} finally {
    rmSync(tmp, { recursive: true, force: true });
}
