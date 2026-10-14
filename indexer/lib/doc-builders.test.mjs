import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEntityDoc } from './doc-builders.mjs';

// B5（overview#606）：生卒年只读 dates，不再回退源记录的旧 birth_year／death_year
test('Entity 文档：有 dates 取 dates，旧 birth_year／death_year 不参与', () => {
    const doc = buildEntityDoc({ id: 'a1', type: 'entity', name: '甲', dates: { birth: 1200, death: 1260 }, birth_year: 1000, death_year: 1100 }, {}, false);
    assert.equal(doc.birth_year, 1200);
    assert.equal(doc.death_year, 1260);
});

test('Entity 文档：无 dates 时生卒年为空，不读旧字段', () => {
    const doc = buildEntityDoc({ id: 'a2', type: 'entity', name: '乙', birth_year: 1000, death_year: 1100 }, {}, false);
    assert.equal(doc.birth_year ?? null, null);
    assert.equal(doc.death_year ?? null, null);
});
