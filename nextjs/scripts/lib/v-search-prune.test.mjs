#!/usr/bin/env node
/** v-search-prune.test.mjs — planVersionPrune() 单测。用法：node --test scripts/lib/v-search-prune.test.mjs */
import test from 'node:test';
import assert from 'node:assert/strict';
import { planVersionPrune, DEFAULT_KEEP_VERSIONS, MIN_AGE_MS } from './v-search-prune.mjs';

const d = (name, t) => ({ name, lastModified: t });

test('只留最新的 keep 个，更旧的删', () => {
    const dirs = [d('a', 1), d('b', 5), d('c', 3), d('e', 4), d('f', 2)];
    const r = planVersionPrune(dirs, { keep: 2 });
    assert.deepEqual(r.toKeep, ['b', 'e']);
    assert.deepEqual(r.toDelete, ['a', 'c', 'f']);
});

test('本次发布的目录一定保留，且不占 keep 名额', () => {
    const dirs = [d('cur', 1), d('commit', 1), d('x', 9), d('y', 8), d('z', 7)];
    const r = planVersionPrune(dirs, { protect: ['cur', 'commit'], keep: 2 });
    assert.deepEqual(r.toKeep, ['commit', 'cur', 'x', 'y']);
    assert.deepEqual(r.toDelete, ['z']);
});

test('取不到时间的目录不动', () => {
    const dirs = [d('a', null), d('b', 1), d('c', 2)];
    const r = planVersionPrune(dirs, { keep: 1 });
    assert.deepEqual(r.toKeep, ['a', 'c']);
    assert.deepEqual(r.toDelete, ['b']);
});

test('目录数不超过 keep 时什么都不删；默认 keep 为 10', () => {
    assert.equal(DEFAULT_KEEP_VERSIONS, 10);
    const dirs = Array.from({ length: 10 }, (_, i) => d(`v${i}`, i));
    assert.deepEqual(planVersionPrune(dirs).toDelete, []);
    assert.deepEqual(planVersionPrune([...dirs, d('old', -1)]).toDelete, ['old']);
});

test('keep=0：除保护目录外全删', () => {
    const r = planVersionPrune([d('a', 1), d('b', 2)], { protect: ['b'], keep: 0 });
    assert.deepEqual(r.toDelete, ['a']);
});

test('24 小时内写的目录不删，不占 keep 名额；更旧的照删', () => {
    const now = 1_000_000_000_000;
    const dirs = [d('new1', now - 1000), d('new2', now - MIN_AGE_MS + 1), d('old1', now - MIN_AGE_MS - 1), d('old2', now - 5 * MIN_AGE_MS)];
    const r = planVersionPrune(dirs, { keep: 1, now });
    assert.deepEqual(r.toKeep, ['new1', 'new2']);
    assert.deepEqual(r.toDelete, ['old1', 'old2']);
    // 不给 now 就不看年龄
    assert.deepEqual(planVersionPrune(dirs, { keep: 1 }).toDelete, ['new2', 'old1', 'old2']);
});
