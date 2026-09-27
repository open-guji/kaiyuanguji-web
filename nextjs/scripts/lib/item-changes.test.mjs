#!/usr/bin/env node
/**
 * item-changes.test.mjs — 改动集纯函数的脚本单测（同 h1-roots.test.mjs 的写法，`node` 直接跑）。
 *
 * 用法：node scripts/lib/item-changes.test.mjs
 */
import assert from 'node:assert/strict';
import { changedShardKeys, diffShard, mergeDiffs } from './item-changes.mjs';

let passed = 0;
function test(name, fn) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); process.exitCode = 1; }
}

test('分片哈希相同的整片跳过，只列不同的和只在一边的', () => {
    const oldRoot = { shards: { '9c': 'aaaa', '10': 'bbbb', 'zz': 'gone' } };
    const newRoot = { shards: { '9c': 'aaaa', '10': 'cccc', '11': 'new1' } };
    assert.deepEqual(changedShardKeys(oldRoot, newRoot), ['10', '11', 'zz']);
});

test('首次发布（没有旧 root）→ 全部分片都算变了', () => {
    assert.deepEqual(changedShardKeys(null, { shards: { b: '1', a: '2' } }), ['a', 'b']);
});

test('分片内逐条比：新增／变更／删除', () => {
    const d = diffShard({ x1: 'h1', x2: 'h2', x3: 'h3' }, { x1: 'h1', x2: 'H2', x4: 'h4' });
    assert.deepEqual(d, { added: ['x4'], changed: ['x2'], removed: ['x3'] });
});

test('一边缺分片：全部新增或全部删除', () => {
    assert.deepEqual(diffShard(null, { a: '1' }), { added: ['a'], changed: [], removed: [] });
    assert.deepEqual(diffShard({ a: '1' }, null), { added: [], changed: [], removed: ['a'] });
});

test('汇总去重排序', () => {
    const m = mergeDiffs([
        { added: ['b'], changed: ['z'], removed: [] },
        { added: ['a', 'b'], changed: [], removed: ['q'] },
    ]);
    assert.deepEqual(m, { added: ['a', 'b'], changed: ['z'], removed: ['q'] });
});

console.log(`\n${passed} 例通过`);
