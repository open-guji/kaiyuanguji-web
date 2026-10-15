import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classificationOf, editionCountOf, entryPath, createReadStats, readDetailDoc, readStatsProblem } from './derived-core.mjs';
import { derivedClassification, editionCount } from './work-fields.mjs';

const VECTORS = JSON.parse(readFileSync(new URL('../../nextjs/src/lib/server/__tests__/fixtures/classification-vectors.json', import.meta.url), 'utf-8'));

test('classificationOf：吃与打包侧同一份黄金向量（B5-3.1／3.3）', () => {
    for (const v of VECTORS) assert.deepEqual(classificationOf(v.entry), v.expect, v.name);
});

test('work-fields 的 derivedClassification／editionCount 就是 core 的同一实现', () => {
    for (const v of VECTORS) assert.deepEqual(derivedClassification(v.entry), v.expect, v.name);
    assert.equal(editionCount({ _edition_count: 3 }), editionCountOf({ _edition_count: 3 }));
    assert.equal(editionCountOf({ _edition_count: 0 }), 0);
    assert.equal(editionCountOf({}), 0);
    assert.equal(editionCountOf(null), 0);
});

function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'derived-core-'));
    const derived = join(root, 'derived'); mkdirSync(join(derived, 'entry'), { recursive: true });
    const src = join(root, 'src'); mkdirSync(src);
    writeFileSync(join(src, 'a.json'), JSON.stringify({ id: 'a', from: 'source' }));
    writeFileSync(join(src, 'b.json'), JSON.stringify({ id: 'b', from: 'source' }));
    writeFileSync(entryPath(derived, 'a'), JSON.stringify({ id: 'a', from: 'derived' }));
    return { derived, a: join(src, 'a.json'), b: join(src, 'b.json') };
}

test('readDetailDoc：有产物读产物并计 hit', () => {
    const f = fixture(); const stats = createReadStats();
    assert.equal(readDetailDoc(f.a, 'a', f.derived, { stats }).from, 'derived');
    assert.deepEqual(stats, { hit: 1, draftSource: 0, missing: 0 });
});

test('readDetailDoc：生产库缺产物→抛错、计 missing、不回退源档', () => {
    const f = fixture(); const stats = createReadStats();
    assert.throws(() => readDetailDoc(f.b, 'b', f.derived, { isDraft: false, stats }), /没有产物/);
    assert.deepEqual(stats, { hit: 0, draftSource: 0, missing: 1 });
});

test('readDetailDoc：草稿库缺产物→读源档、计 draftSource、不失败', () => {
    const f = fixture(); const stats = createReadStats();
    assert.equal(readDetailDoc(f.b, 'b', f.derived, { isDraft: true, stats }).from, 'source');
    assert.deepEqual(stats, { hit: 0, draftSource: 1, missing: 0 });
});

test('readDetailDoc：没设产物目录（旧 schema／ALLOW_NO_DERIVED）照旧读源档、不计数', () => {
    const f = fixture(); const stats = createReadStats();
    assert.equal(readDetailDoc(f.a, 'a', '', { stats }).from, 'source');
    assert.equal(readDetailDoc(f.a, 'a', '  ', { stats }).from, 'source');
    assert.deepEqual(stats, { hit: 0, draftSource: 0, missing: 0 });
});

test('readStatsProblem：missing>0 才是问题，草稿读源档不是', () => {
    assert.equal(readStatsProblem(createReadStats()), null);
    assert.equal(readStatsProblem({ hit: 5, draftSource: 9, missing: 0 }), null);
    assert.match(readStatsProblem({ hit: 5, draftSource: 9, missing: 2 }), /2 个条目读不到/);
    assert.equal(readStatsProblem(null), null);
});
