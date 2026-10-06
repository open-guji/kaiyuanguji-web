import test from 'node:test';
import assert from 'node:assert/strict';
import { checkDocFloor, MIN_DOC_RATIO } from './doc-floor.mjs';

test('线上没有或为空：不拦', () => {
    assert.equal(checkDocFloor(null, 0).ok, true);
    assert.equal(checkDocFloor(0, 0).ok, true);
    assert.equal(checkDocFloor(undefined, 5).ok, true);
});

test('juans 建出 0 条（10-02 事故）：拦', () => {
    const r = checkDocFloor(1781, 0);
    assert.equal(r.ok, false);
    assert.match(r.reason, /0 条.*1781/);
});

test('正常增减不拦；刚好一半不拦，少于一半拦', () => {
    assert.equal(checkDocFloor(95055, 95100).ok, true);
    assert.equal(checkDocFloor(95055, 90000).ok, true);
    assert.equal(checkDocFloor(100, 50).ok, true);
    assert.equal(checkDocFloor(100, 49).ok, false);
    assert.equal(MIN_DOC_RATIO, 0.5);
});

test('新文档数读不到按 0 算', () => {
    assert.equal(checkDocFloor(10, undefined).ok, false);
});
