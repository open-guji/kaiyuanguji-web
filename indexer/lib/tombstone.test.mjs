import test from 'node:test';
import assert from 'node:assert/strict';
import { isPromotedTombstone, promotedTo } from './tombstone.mjs';

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
