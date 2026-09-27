#!/usr/bin/env node
/**
 * h1-promotions.test.mjs — 升格对照表分片（PH）的脚本单测，外加 runRootsRetention
 * 对另列分片集（promotionShards）的在用判定。与 h1-orphans.test.mjs 同一套写法。
 *
 * 用法：node scripts/lib/h1-promotions.test.mjs
 */

import assert from 'node:assert/strict';
import { buildPromotionShards } from './h1-promotions.mjs';
import { runRootsRetention } from './h1-sync-core.mjs';

let passed = 0;
async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (e) {
        console.error(`  ✗ ${name}`);
        console.error(`    ${e.message}`);
        process.exitCode = 1;
    }
}

const rec = (to) => ({ production_id: to, type: 'work', promoted_at: '2026-05-15T03:00:47Z' });

await test('按草稿 id 末 2 位分片，分片内容是扁平的 草稿id→正式id', () => {
    const { shards, count, skipped } = buildPromotionShards({
        version: 1,
        promotions: { '11pcgxhot4bnk': rec('96kzii6z28'), '22abcdefgbnk': rec('96kzii6z29'), '33abcdefg0a1': rec('96kzii6z30') },
    }, 2);
    assert.equal(count, 3);
    assert.equal(skipped, 0);
    assert.deepEqual(shards, {
        nk: { '11pcgxhot4bnk': '96kzii6z28', '22abcdefgbnk': '96kzii6z29' },
        a1: { '33abcdefg0a1': '96kzii6z30' },
    });
});

await test('分片内容与源文件键序无关（哈希稳定）', () => {
    const a = buildPromotionShards({ version: 1, promotions: { aaaaaabnk: rec('bbbbbb1'), ccccccbnk: rec('dddddd1') } }, 2);
    const b = buildPromotionShards({ version: 1, promotions: { ccccccbnk: rec('dddddd1'), aaaaaabnk: rec('bbbbbb1') } }, 2);
    assert.equal(JSON.stringify(a.shards), JSON.stringify(b.shards));
});

await test('坏记录跳过：缺 production_id、id 形态不对、自己指向自己', () => {
    const { shards, count, skipped } = buildPromotionShards({
        version: 1,
        promotions: {
            aaaaaa01: rec('bbbbbb01'),
            aaaaaa02: { type: 'work' },
            'AAAA/..': rec('bbbbbb03'),
            aaaaaa04: rec('../etc'),
            aaaaaa05: rec('aaaaaa05'),
            aaaaaa06: null,
        },
    }, 2);
    assert.equal(count, 1);
    assert.equal(skipped, 5);
    assert.deepEqual(shards, { '01': { aaaaaa01: 'bbbbbb01' } });
});

await test('空表 / 版本不对 / 非对象 → 没有分片', () => {
    for (const raw of [{ version: 1, promotions: {} }, { version: 2, promotions: { aaaaaa01: rec('bbbbbb01') } }, null, 'x']) {
        const r = buildPromotionShards(raw, 2);
        assert.deepEqual(r.shards, {});
        assert.equal(r.count, 0);
    }
});

// ─── runRootsRetention：promotionShards 与 manifest 分片同一套「在用 root 引用才活」 ───

function memBackend(init) {
    const store = { ...init };
    return {
        store,
        async readText(k) { return k in store ? store[k] : null; },
        async writeText(k, v) { store[k] = v; },
        async deleteKey(k) { delete store[k]; },
        async listPrefix(p) { return Object.keys(store).filter((k) => k.startsWith(p)).map((k) => k.slice(p.length)); },
    };
}

const CFG = {
    h1Prefix: 'h1', manifestSubdir: 'manifest', rootsSubdir: 'roots',
    pointerKey: 'h1/manifest-root.json', ledgerKey: 'h1/_meta/roots-history.json',
    shortCacheControl: 'x', extraShardSets: [{ subdir: 'promotions', field: 'promotionShards', label: '升格对照表' }],
};

await test('旧 root 引用的对照表分片保留，谁都不引用的删掉；旧 root 没有 promotionShards 也不出错', async () => {
    const oldRoot = { shards: { aa: 'm0' }, promotionShards: { nk: 'p0' } };
    const olderRoot = { shards: { aa: 'm0' } }; // PH 之前的 root，没有 promotionShards
    const b = memBackend({
        'h1/manifest-root.json': JSON.stringify({ root: 'c1.json' }),
        'h1/roots/c1.json': JSON.stringify(oldRoot),
        'h1/roots/c0.json': JSON.stringify(olderRoot),
        'h1/_meta/roots-history.json': JSON.stringify({ version: 1, history: [{ commit: 'c1', generatedAt: 2 }, { commit: 'c0', generatedAt: 1 }] }),
        'h1/manifest/aa.m0.json': '{}',
        'h1/promotions/nk.p0.json': '{}',      // c1 在用
        'h1/promotions/nk.p1.json': '{}',      // 本轮新
        'h1/promotions/zz.pdead.json': '{}',   // 谁都不引用
    });
    const newRootDoc = { shards: { aa: 'm0' }, promotionShards: { nk: 'p1' } };
    const stats = await runRootsRetention(b, { ...CFG, newCommit: 'c2', newRootDoc });
    const promos = Object.keys(b.store).filter((k) => k.startsWith('h1/promotions/')).sort();
    assert.deepEqual(promos, ['h1/promotions/nk.p0.json', 'h1/promotions/nk.p1.json']);
    assert.deepEqual(stats.extra, [{ label: '升格对照表', live: 2, deleted: 1 }]);
    assert.ok(b.store['h1/manifest/aa.m0.json']);
});

await test('不传 extraShardSets 时不碰 promotions/ 前缀（text 那条 sync 的行为不变）', async () => {
    const b = memBackend({ 'h1/promotions/zz.pdead.json': '{}' });
    const { extraShardSets, ...cfg } = CFG;
    await runRootsRetention(b, { ...cfg, newCommit: 'c2', newRootDoc: { shards: {} } });
    assert.ok(b.store['h1/promotions/zz.pdead.json']);
});

console.log(`\n${passed} 例通过`);
