#!/usr/bin/env node
/**
 * h1-orphans.test.mjs — planOrphans() 的脚本单测（不进 jest：这是 scripts/ 下的
 * 纯 Node 模块，不属于 next/jest 覆盖的 src/ 树）。
 *
 * 覆盖协调者验收第三轮点名的三种情况：
 *   1. 很久以前上传、本次刚成为孤儿 → 保留（不因为「上传得早」就当场删）
 *   2. 成为孤儿满 7 天 → 删除
 *   3. 成为孤儿后又被引用（hash 回到旧值）→ 移出表，不算删除也不算保留
 *
 * 用法：node scripts/lib/h1-orphans.test.mjs
 */

import assert from 'node:assert/strict';
import { planOrphans, ORPHAN_RETENTION_MS, serializeOrphansTable, parseOrphansTable } from './h1-orphans.mjs';

let passed = 0;
function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (e) {
        console.error(`  ✗ ${name}`);
        console.error(`    ${e.message}`);
        process.exitCode = 1;
    }
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-26T12:00:00Z');

test('很久以前上传、本次刚成为孤儿 → 保留（第三轮要修的那个 bug：不能按上传时间算老）', () => {
    // 关键：orphansTable 一开始是空的（这条 entry 从没进过孤儿表，因为它昨天
    // 还在被引用）——即便对应的物理文件早在 30 天前就上传到了 COS，
    // 「成为孤儿」这件事是这一轮才发生的，年龄应该从 0 开始算，不是从上传时间算。
    const result = planOrphans({
        orphansTable: new Map(),
        candidateOrphanRels: ['entry/abc123.oldhash01.json'],
        currentLocalEntryRelSet: new Set(['entry/abc123.newhash02.json']), // 新版本已经在本地
        now: NOW,
    });

    assert.equal(result.added, 1);
    assert.deepEqual(result.toDelete, []);
    assert.deepEqual(result.toKeep, ['entry/abc123.oldhash01.json']);
    assert.equal(result.newOrphansTable.get('entry/abc123.oldhash01.json'), NOW);
});

test('成为孤儿满 7 天 → 删除，且从表里移除', () => {
    const eightDaysAgo = NOW - 8 * DAY;
    const result = planOrphans({
        orphansTable: new Map([['entry/abc123.oldhash01.json', eightDaysAgo]]),
        candidateOrphanRels: [], // 本轮没有新孤儿，只是老孤儿到期了
        currentLocalEntryRelSet: new Set(['entry/abc123.newhash02.json']),
        now: NOW,
    });

    assert.deepEqual(result.toDelete, ['entry/abc123.oldhash01.json']);
    assert.deepEqual(result.toKeep, []);
    assert.equal(result.newOrphansTable.has('entry/abc123.oldhash01.json'), false);
});

test('刚好卡在 7 天整 → 判定为「满」（边界取闭区间，>= 不是 >）', () => {
    const exactlySevenDaysAgo = NOW - ORPHAN_RETENTION_MS;
    const result = planOrphans({
        orphansTable: new Map([['entry/x.h1.json', exactlySevenDaysAgo]]),
        candidateOrphanRels: [],
        currentLocalEntryRelSet: new Set(),
        now: NOW,
    });
    assert.deepEqual(result.toDelete, ['entry/x.h1.json']);
});

test('未满 7 天（6 天 23 小时）→ 仍然保留', () => {
    const almostSevenDays = NOW - (ORPHAN_RETENTION_MS - 60 * 60 * 1000);
    const result = planOrphans({
        orphansTable: new Map([['entry/x.h1.json', almostSevenDays]]),
        candidateOrphanRels: [],
        currentLocalEntryRelSet: new Set(),
        now: NOW,
    });
    assert.deepEqual(result.toKeep, ['entry/x.h1.json']);
    assert.deepEqual(result.toDelete, []);
});

test('成为孤儿后又被引用（hash 回到旧值）→ 移出表，不删不保留', () => {
    // 场景：id 的内容从 A 改成 B（A 变孤儿，记了 orphanedSince），
    // 又改回了 A（一字不差，hash 也一样）——A 这个 entry 文件重新出现在本地。
    const threeDaysAgo = NOW - 3 * DAY;
    const result = planOrphans({
        orphansTable: new Map([['entry/abc123.hashA.json', threeDaysAgo]]),
        candidateOrphanRels: [],
        currentLocalEntryRelSet: new Set(['entry/abc123.hashA.json']), // 又回来了
        now: NOW,
    });

    assert.equal(result.reReferenced, 1);
    assert.deepEqual(result.toDelete, []);
    assert.deepEqual(result.toKeep, []);
    assert.equal(result.newOrphansTable.has('entry/abc123.hashA.json'), false);
});

test('三种情况同一轮混着发生，互不干扰', () => {
    const eightDaysAgo = NOW - 8 * DAY;
    const threeDaysAgo = NOW - 3 * DAY;
    const result = planOrphans({
        orphansTable: new Map([
            ['entry/expired.h1.json', eightDaysAgo],   // 该删
            ['entry/backagain.h1.json', threeDaysAgo], // 该移出（重新引用）
        ]),
        candidateOrphanRels: ['entry/fresh.h1.json'],  // 该新增、保留
        currentLocalEntryRelSet: new Set(['entry/backagain.h1.json']),
        now: NOW,
    });

    assert.deepEqual(result.toDelete, ['entry/expired.h1.json']);
    assert.deepEqual(result.toKeep, ['entry/fresh.h1.json']);
    assert.equal(result.reReferenced, 1);
    assert.equal(result.added, 1);
    assert.equal(result.newOrphansTable.size, 1); // 只剩 fresh 一条
});

test('序列化/反序列化往返不丢数据', () => {
    const table = new Map([['entry/a.h1.json', NOW], ['entry/b.h2.json', NOW - DAY]]);
    const round = parseOrphansTable(serializeOrphansTable(table));
    assert.deepEqual([...round.entries()].sort(), [...table.entries()].sort());
});

test('parseOrphansTable 对损坏/缺失内容容错为空表', () => {
    assert.equal(parseOrphansTable('not json').size, 0);
    assert.equal(parseOrphansTable('{}').size, 0);
    assert.equal(parseOrphansTable('{"version":2,"orphans":{}}').size, 0);
});

console.log(`\n${passed} passed`);
if (process.exitCode) {
    console.error('\n❌ h1-orphans 单测有失败');
} else {
    console.log('\n✅ h1-orphans 单测全过');
}
