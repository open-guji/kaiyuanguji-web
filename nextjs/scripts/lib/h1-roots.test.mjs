#!/usr/bin/env node
/**
 * h1-roots.test.mjs — h1 版本根清单（S3）三个纯函数的脚本单测（不进 jest，
 * 跟 h1-orphans.test.mjs／h1-sync-core.test.mjs 同一套写法：`node` 直接跑）。
 *
 * 用法：node scripts/lib/h1-roots.test.mjs
 */

import assert from 'node:assert/strict';
import {
    planLiveCommits, planShardRetention, planRootsFileRetention,
    commitFromRootFilename, serializeRootsLedger, parseRootsLedger,
} from './h1-roots.mjs';

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

// ─── planLiveCommits ───

test('首次发布：ledger 为空，无当前指针、无测试站指针 → 在用集合只有新 commit', () => {
    const { liveCommitSet, prunedLedger, retiredCommits } = planLiveCommits({
        ledger: [], newCommit: 'c-new', now: 1000,
    });
    assert.deepEqual([...liveCommitSet].sort(), ['c-new']);
    assert.deepEqual(prunedLedger, [{ commit: 'c-new', generatedAt: 1000 }]);
    assert.deepEqual(retiredCommits, []);
});

test('保留最近 N 个（默认 5）：ledger 有 6 个旧的 + 1 个新的，只留最近 5 个（含新的）', () => {
    const ledger = Array.from({ length: 6 }, (_, i) => ({ commit: `c${i}`, generatedAt: i * 100 }));
    // c0..c5，generatedAt 递增（c5 最新），加上 now=10000 的新 commit 共 7 个，keepN=5 只留最新 5 个
    const { liveCommitSet, retiredCommits } = planLiveCommits({
        ledger, newCommit: 'c-new', keepN: 5, now: 10000,
    });
    assert.deepEqual([...liveCommitSet].sort(), ['c-new', 'c2', 'c3', 'c4', 'c5'].sort());
    assert.deepEqual(retiredCommits.sort(), ['c0', 'c1'].sort());
});

test('当前指针与测试站指针即使不在最近 N 个里，也算在用', () => {
    const ledger = Array.from({ length: 10 }, (_, i) => ({ commit: `c${i}`, generatedAt: i * 100 }));
    const { liveCommitSet, retiredCommits } = planLiveCommits({
        ledger, newCommit: 'c-new',
        currentPointerCommit: 'c0', // 最旧的一个，本该被 topN 挤出去
        stagingPointerCommit: 'c1',
        keepN: 3, now: 100000,
    });
    assert.ok(liveCommitSet.has('c0'), '当前指针指向的旧 commit 必须保留');
    assert.ok(liveCommitSet.has('c1'), '测试站指针指向的旧 commit 必须保留');
    assert.ok(!retiredCommits.includes('c0'));
    assert.ok(!retiredCommits.includes('c1'));
});

test('没有测试站指针（stagingPointerCommit=null，今天的常态）：不影响在用集合大小', () => {
    const { liveCommitSet } = planLiveCommits({
        ledger: [], newCommit: 'c-new', currentPointerCommit: null, stagingPointerCommit: null, now: 1,
    });
    assert.equal(liveCommitSet.size, 1);
});

test('同一个 commit 重复发布（内容未变、只是重跑）：ledger 不重复记两条', () => {
    const ledger = [{ commit: 'c-new', generatedAt: 500 }];
    const { prunedLedger } = planLiveCommits({ ledger, newCommit: 'c-new', now: 999 });
    assert.equal(prunedLedger.length, 1);
    assert.equal(prunedLedger[0].generatedAt, 500, '已存在的 commit 不应该被 now 覆盖它的 generatedAt');
});

// ─── planShardRetention ───

test('分片：只删「没有任何在用 root 引用」的文件；被至少一个在用 root 引用就保留', () => {
    const liveShardsMaps = [
        { aa: 'hash1', bb: 'hash2' }, // 当前 root
        { aa: 'hash0' },              // 上一个 root：aa 的旧哈希仍在用（读者可能还持有旧 root）
    ];
    const cosShardFiles = ['aa.hash1.json', 'aa.hash0.json', 'bb.hash2.json', 'cc.dead.json'];
    const { toDelete, liveFileCount } = planShardRetention({ liveShardsMaps, cosShardFiles });
    assert.deepEqual(toDelete, ['cc.dead.json']);
    assert.equal(liveFileCount, 3);
});

test('分片：迁移前遗留的无哈希旧名（如 "aa.json"）不会出现在在用集合里，判定删除', () => {
    const liveShardsMaps = [{ aa: 'newhash' }];
    const cosShardFiles = ['aa.json', 'aa.newhash.json'];
    const { toDelete } = planShardRetention({ liveShardsMaps, cosShardFiles });
    assert.deepEqual(toDelete, ['aa.json']);
});

test('分片：某在用 commit 的 root 文档拉不到（调用方传空对象）不影响其余 commit 的保护范围', () => {
    const liveShardsMaps = [{ aa: 'h1' }, {}];
    const cosShardFiles = ['aa.h1.json', 'bb.h2.json'];
    const { toDelete } = planShardRetention({ liveShardsMaps, cosShardFiles });
    assert.deepEqual(toDelete, ['bb.h2.json']);
});

// ─── planRootsFileRetention ───

test('roots 文件：不在在用 commit 集合里的旧发布可以删', () => {
    const liveCommitSet = new Set(['c-new', 'c1']);
    const cosRootFiles = ['c-new.json', 'c1.json', 'c0.json'];
    const { toDelete } = planRootsFileRetention({ liveCommitSet, cosRootFiles });
    assert.deepEqual(toDelete, ['c0.json']);
});

test('commitFromRootFilename：去掉 .json 后缀', () => {
    assert.equal(commitFromRootFilename('abcd1234.json'), 'abcd1234');
    assert.equal(commitFromRootFilename('abcd1234'), 'abcd1234'); // 容错：没有后缀也不炸
});

// ─── 序列化往返 ───

test('serializeRootsLedger / parseRootsLedger 往返一致', () => {
    const ledger = [{ commit: 'c1', generatedAt: 111 }, { commit: 'c2', generatedAt: 222 }];
    const raw = serializeRootsLedger(ledger);
    assert.deepEqual(parseRootsLedger(raw), ledger);
});

test('parseRootsLedger：内容损坏或版本不对 → 视同空表，不炸', () => {
    assert.deepEqual(parseRootsLedger('not json'), []);
    assert.deepEqual(parseRootsLedger(JSON.stringify({ version: 2, history: [] })), []);
    assert.deepEqual(parseRootsLedger(JSON.stringify({ version: 1, history: 'nope' })), []);
});

console.log(`\n${passed} passed`);
if (process.exitCode) {
    console.error('\n❌ h1-roots 单测有失败');
} else {
    console.log('\n✅ h1-roots 单测全过');
}
