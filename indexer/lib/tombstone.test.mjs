import test from 'node:test';
import assert from 'node:assert/strict';
import { isPromotedTombstone, promotedTo, mergedInto, isMergedTombstone, isTombstone } from './tombstone.mjs';

test('墓碑：promoted_to（产物）与 _promoted_to（旧）两个键都认', () => {
    assert.equal(promotedTo({ promoted_to: 'abc' }), 'abc');
    assert.equal(promotedTo({ _promoted_to: 'xyz' }), 'xyz');
    assert.equal(promotedTo({ promoted_to: 'abc', _promoted_to: 'xyz' }), 'abc'); // 产物字段优先
    assert.equal(promotedTo({ promoted_to: '', _promoted_to: 'xyz' }), 'xyz');
    assert.equal(isPromotedTombstone({ promoted_to: 'abc' }), true);
    assert.equal(isPromotedTombstone({ _promoted_to: 'xyz' }), true);
});

test('非墓碑：没有字段、空值、null／非对象都不算', () => {
    assert.equal(isPromotedTombstone({ id: 'a', title: 't' }), false);
    assert.equal(isPromotedTombstone({ promoted_to: '', _promoted_to: null }), false);
    assert.equal(isPromotedTombstone(null), false);
    assert.equal(isPromotedTombstone(undefined), false);
    assert.equal(isPromotedTombstone('x'), false);
});

test('并条墓碑：merged_into 字符串或带 id 的对象都认', () => {
    assert.equal(mergedInto({ merged_into: 'abc' }), 'abc');
    assert.equal(mergedInto({ merged_into: { id: 'xyz' } }), 'xyz');
    assert.equal(isMergedTombstone({ id: 'a', merged_into: 'abc' }), true);
});

test('非并条墓碑：没有字段、空串、无 id 的对象、null／非对象都不算；keeper 的 merged_from 不算', () => {
    assert.equal(isMergedTombstone({ id: 'a', merged_from: ['b'] }), false);
    assert.equal(isMergedTombstone({ merged_into: '' }), false);
    assert.equal(isMergedTombstone({ merged_into: {} }), false);
    assert.equal(isMergedTombstone({ merged_into: 3 }), false);
    assert.equal(isMergedTombstone(null), false);
    assert.equal(isMergedTombstone('x'), false);
});

test('isTombstone：升格墓碑与并条墓碑都滤，普通条目不滤', () => {
    assert.equal(isTombstone({ promoted_to: 'p' }), true);
    assert.equal(isTombstone({ merged_into: 'm' }), true);
    assert.equal(isTombstone({ id: 'a', title: 't' }), false);
    assert.equal(isTombstone(null), false);
});
