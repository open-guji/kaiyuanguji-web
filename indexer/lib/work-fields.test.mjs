import test from 'node:test';
import assert from 'node:assert/strict';
import { classificationL1, derivedClassification, editionCount } from './work-fields.mjs';

test('分类：build 产物 _classifications 优先（zongmu），回退旧 classification，再回退分片行', () => {
    const detail = { classification: { l1: '舊部' }, _classifications: [{ scheme: 'x', l1: '乙部' }, { scheme: 'zongmu', l1: '史部' }] };
    assert.equal(classificationL1(derivedClassification(detail), detail.classification, { l1: '行' }), '史部');
    assert.equal(classificationL1(derivedClassification({ classification: { l1: '經部' } }), { l1: '經部' }), '經部');
    assert.equal(classificationL1(derivedClassification({}), undefined, { l1: '集部' }), '集部');
    assert.equal(classificationL1(derivedClassification({ _classifications: [] })), '');
});

test('版本数：_edition_count 优先（含 0），回退 books 数组长度', () => {
    assert.equal(editionCount({ _edition_count: 3, books: ['a'] }), 3);
    assert.equal(editionCount({ _edition_count: 0, books: ['a'] }), 0);
    assert.equal(editionCount({ books: ['a', 'b'] }), 2);
    assert.equal(editionCount({}), 0);
    assert.equal(editionCount(null), 0);
});
