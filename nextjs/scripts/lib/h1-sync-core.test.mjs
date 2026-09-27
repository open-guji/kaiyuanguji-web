#!/usr/bin/env node
/**
 * h1-sync-core.test.mjs — planBatches() 的脚本单测（不进 jest：这是 scripts/ 下的
 * 纯 Node 模块，不属于 next/jest 覆盖的 src/ 树，与 h1-orphans.test.mjs 同一套写法）。
 *
 * planBatches 是共用 sync 引擎的核心分类逻辑（哪些文件归哪一批要传、哪些孤儿
 * 走保留期候选、哪些孤儿当场删）——entry 与 text 两条 sync 脚本的行为差异
 * 全部由传给它的 config.batches 决定，这里用最小的假配置覆盖三种情况，
 * 不依赖真实文件系统或真实 COS。
 *
 * 用法：node scripts/lib/h1-sync-core.test.mjs
 */

import assert from 'node:assert/strict';
import { planBatches } from './h1-sync-core.mjs';

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

// 模拟 entry 的三批配置：primary（保留 7 天）／shard（当场删）／root（当场删）
const CONFIG = {
    batches: [
        { key: 'primary', label: '① primary', match: (rel) => rel.startsWith('primary/'), retain: true },
        { key: 'shard', label: '② shard', match: (rel) => rel.startsWith('shard/'), retain: false },
        { key: 'root', label: '③ root', match: (rel) => rel === 'root.json', retain: false },
    ],
};

function file(relative, size = 10) {
    return { full: `/tmp/${relative}`, relative, size, mtimeMs: 0 };
}

test('首次全量：state 为空，全部文件落进对应批次的 upload 列表', () => {
    const files = [file('primary/a.json'), file('shard/01.json'), file('root.json')];
    const stateMap = new Map();
    const localMd5 = new Map([['primary/a.json', 'h1'], ['shard/01.json', 'h2'], ['root.json', 'h3']]);

    const plan = planBatches(CONFIG, files, stateMap, localMd5);

    assert.equal(plan.uploadsByBatch.find(b => b.key === 'primary').upload.length, 1);
    assert.equal(plan.uploadsByBatch.find(b => b.key === 'shard').upload.length, 1);
    assert.equal(plan.uploadsByBatch.find(b => b.key === 'root').upload.length, 1);
    assert.equal(plan.skipped, 0);
    assert.deepEqual(plan.retainOrphanCandidates, []);
    assert.deepEqual(plan.immediateOrphansToDelete, []);
});

test('内容未变的文件不进 upload 列表（md5 相同即跳过）', () => {
    const files = [file('primary/a.json')];
    const stateMap = new Map([['primary/a.json', 'h1']]);
    const localMd5 = new Map([['primary/a.json', 'h1']]);

    const plan = planBatches(CONFIG, files, stateMap, localMd5);

    assert.equal(plan.uploadsByBatch.find(b => b.key === 'primary').upload.length, 0);
    assert.equal(plan.skipped, 1);
});

test('retain 批的孤儿进保留期候选，非 retain 批的孤儿当场删', () => {
    const files = []; // 本地什么都没有了
    const stateMap = new Map([
        ['primary/gone.json', 'oldhash'],  // retain 批 → 候选，走 7 天保留期判断
        ['shard/gone.json', 'oldhash'],    // 非 retain 批 → 当场删
        ['root.json', 'oldhash'],          // 非 retain 批 → 当场删
    ]);
    const localMd5 = new Map();

    const plan = planBatches(CONFIG, files, stateMap, localMd5);

    assert.deepEqual(plan.retainOrphanCandidates, ['primary/gone.json']);
    assert.deepEqual(plan.immediateOrphansToDelete.sort(), ['root.json', 'shard/gone.json']);
});

test('不属于任何已知批次的历史遗留 rel（如布局迁移期的旧前缀）：不动，不算孤儿', () => {
    const files = [];
    const stateMap = new Map([['legacy-prefix/whatever.json', 'h1']]);
    const localMd5 = new Map();

    const plan = planBatches(CONFIG, files, stateMap, localMd5);

    assert.deepEqual(plan.retainOrphanCandidates, []);
    assert.deepEqual(plan.immediateOrphansToDelete, []);
});

// S3（h1 版本根清单）：manifest/roots 这类批次标 skipOrphans，孤儿判定挪到
// runRootsRetention（按在用 root 集合算），本地没有不再等于「可以删」——
// 见 bundle-hashed.mjs 里旧 commit 的分片本来就不会出现在本轮本地产物里。
const CONFIG_WITH_SKIP_ORPHANS = {
    batches: [
        { key: 'primary', label: '① primary', match: (rel) => rel.startsWith('primary/'), retain: true },
        { key: 'shard', label: '② shard（按在用 root 集合另算孤儿）', match: (rel) => rel.startsWith('shard/'), retain: false, skipOrphans: true },
    ],
};

test('skipOrphans 批次：本地消失的 rel 既不进保留候选，也不进当场删除列表', () => {
    const files = []; // 本地什么都没有了（这一轮只反映当前这一个 commit 的内容）
    const stateMap = new Map([
        ['primary/gone.json', 'oldhash'],
        ['shard/still-live-elsewhere.json', 'oldhash'], // 可能还被别的在用 root 引用，不该被这里的逻辑动
    ]);
    const localMd5 = new Map();

    const plan = planBatches(CONFIG_WITH_SKIP_ORPHANS, files, stateMap, localMd5);

    assert.deepEqual(plan.retainOrphanCandidates, ['primary/gone.json']); // retain 批不受影响
    assert.deepEqual(plan.immediateOrphansToDelete, []); // skipOrphans 批一个都不进
});

console.log(`\n${passed} passed`);
if (process.exitCode) {
    console.error('\n❌ h1-sync-core 单测有失败');
} else {
    console.log('\n✅ h1-sync-core 单测全过');
}
