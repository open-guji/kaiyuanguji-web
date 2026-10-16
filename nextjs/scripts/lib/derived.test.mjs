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
    assertDerivedDir, classificationOf, derivedDir, derivedPath, entryReadStatsSnapshot, indexDirFor, readEntryDoc, reportEntryReads,
    resetEntryReadStats, summarizeEntryReads, taxonomyFileFor,
} from './derived.mjs';
// B5-3.2：打包默认严格（必须设 BOOK_INDEX_DERIVED_DIR）；本组用例用源档夹具，显式走本地开发开关
process.env.ALLOW_SOURCE_FALLBACK = '1';

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
    // 黄金向量：与 src/lib/server/item-relations.ts 的 classificationOf 共用同一份（B5-3.1），两边都要过
    const vectors = JSON.parse(readFileSync(new URL('../../src/lib/server/__tests__/fixtures/classification-vectors.json', import.meta.url), 'utf-8'));
    for (const v of vectors) {
        const got = classificationOf(v.entry);
        if (v.expect === null) assert.equal(got, null, v.name);
        else assert.deepEqual({ l1: got.l1, l2: got.l2, l3: got.l3, l4: got.l4 }, v.expect, v.name);
    }
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
    // 本地开发开关（ALLOW_SOURCE_FALLBACK=1）：回退只警告、不失败
    const lenient = { BOOK_INDEX_DERIVED_DIR: der, ALLOW_SOURCE_FALLBACK: '1', GITHUB_STEP_SUMMARY: sumFile };
    const r1 = reportEntryReads({ env: lenient, ...io });
    assert.equal(r1.enabled, true);
    assert.equal(r1.fallback, 1);
    assert.equal(r1.fail, false);
    assert.equal(warns.length, 2); // 回退 1 条＋缺条目 1 条各一句
    assert.ok(logs[0].includes('命中产物 2，回退源档 1'));
    assert.ok(readFileSync(sumFile, 'utf-8').includes('回退源档 1'));
    // 严格（默认，STRICT_DERIVED 有没有都一样）：回退>0 失败；缺条目>0 失败；干净才过
    assert.equal(reportEntryReads({ env: { BOOK_INDEX_DERIVED_DIR: der }, ...io }).fail, true);
    assert.equal(summarizeEntryReads({ BOOK_INDEX_DERIVED_DIR: der, STRICT_DERIVED: '0' }).fail, true);
    assert.equal(summarizeEntryReads({ BOOK_INDEX_DERIVED_DIR: der }, { entry: { hit: 5, fallback: 0, missing: 0 } }).fail, false);
    assert.equal(summarizeEntryReads({ BOOK_INDEX_DERIVED_DIR: der }, { entry: { hit: 5, fallback: 0, missing: 1 } }).fail, true);
    assert.equal(summarizeEntryReads({ BOOK_INDEX_DERIVED_DIR: der, ALLOW_SOURCE_FALLBACK: '1' }, { entry: { hit: 5, fallback: 0, missing: 1 } }).fail, false);
    // 没设产物目录：严格模式失败（以前不判闸）；ALLOW_SOURCE_FALLBACK=1 才放行
    const r0 = summarizeEntryReads({}, { entry: { hit: 0, fallback: 9, missing: 0 } });
    assert.equal(r0.enabled, false);
    assert.equal(r0.fail, true);
    assert.equal(summarizeEntryReads({ ALLOW_SOURCE_FALLBACK: '1' }, { entry: { hit: 0, fallback: 9, missing: 0 } }).fail, false);
    assert.equal(reportEntryReads({ env: {}, stats: {}, ...io }).fail, true); // 一条都没读也失败：没设目录就是没设
    // 严格读：没设目录 → 抛错（写明缺什么）；缺条目 → null 且不回退源档
    delete process.env.ALLOW_SOURCE_FALLBACK;
    assert.throws(() => readEntryDoc({ id: 'a', srcPath: join(prod, 'Work', 'a.json'), dir: null }), /BOOK_INDEX_DERIVED_DIR/);
    assert.throws(() => assertDerivedDir({}), /ALLOW_SOURCE_FALLBACK=1/);
    assert.doesNotThrow(() => assertDerivedDir({ ALLOW_SOURCE_FALLBACK: '1' }));
    assert.doesNotThrow(() => assertDerivedDir({ BOOK_INDEX_DERIVED_DIR: der }));
    resetEntryReadStats();
    assert.equal(readEntryDoc({ id: 'b', srcPath: join(prod, 'Work', 'b.json'), dir: der }), null); // 源档有也不读
    assert.deepEqual(entryReadStatsSnapshot(), { entry: { hit: 0, fallback: 0, missing: 1 } });
    assert.equal(readEntryDoc({ id: 'a', srcPath: join(prod, 'Work', 'a.json'), dir: der }).derived, true);
    process.env.ALLOW_SOURCE_FALLBACK = '1';
    resetEntryReadStats();
    console.log('derived.test.mjs ✓');
} finally {
    rmSync(tmp, { recursive: true, force: true });
}
