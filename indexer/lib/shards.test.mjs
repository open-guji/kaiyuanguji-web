import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { indexDirFor, iterIndexShards, iterAllRoots } from './shards.mjs';

function put(dir, rel, obj) {
    const p = join(dir, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, JSON.stringify(obj));
}

function fixture() {
    const base = mkdtempSync(join(tmpdir(), 'shards-'));
    const repo = join(base, 'book-index');
    const derived = join(base, 'derived');
    put(repo, 'index/works/0.json', { w1: { id: 'w1', title: '仓内', path: 'Work/a/w1.json' } });
    put(derived, 'index/works/0.json', { w1: { id: 'w1', title: '产物', path: 'Work/a/w1.json' }, w0: { id: 'w0', promoted_to: 'x' } });
    put(derived, 'index/collections.json', { c1: { id: 'c1', title: '叢編' } });
    return { base, repo, derived };
}

test('indexDirFor：产物有 index/ 用产物的，否则（没设／没有 index/）用源仓的', () => {
    const { base, repo, derived } = fixture();
    assert.equal(indexDirFor(repo, derived), join(derived, 'index'));
    assert.equal(indexDirFor(repo, `  ${derived}  `), join(derived, 'index'));
    assert.equal(indexDirFor(repo, ''), join(repo, 'index'));
    assert.equal(indexDirFor(repo), join(repo, 'index'));
    assert.equal(indexDirFor(repo, join(base, 'nope')), join(repo, 'index'));
});

test('iterIndexShards：缺省读 rootDir/index，给了 indexDir 读它；单文件分片（collections.json）照读', () => {
    const { repo, derived } = fixture();
    assert.deepEqual([...iterIndexShards(repo, 'works')].map((e) => e.title), ['仓内']);
    assert.deepEqual([...iterIndexShards(repo, 'works', join(derived, 'index'))].map((e) => e.title), ['产物', undefined]);
    assert.deepEqual([...iterIndexShards(repo, 'collections', join(derived, 'index'))].map((e) => e.id), ['c1']);
});

test('iterIndexShards：分片源没了读到 0 条（不抛错，由下游条数闸挡）', () => {
    const { base } = fixture();
    assert.deepEqual([...iterIndexShards(join(base, 'gone'), 'works')], []);
});

test('iterAllRoots：按 root 的 indexDir 读分片，rootDir 仍是源仓（详情 path 相对它解析）；跳过升格墓碑', () => {
    const { repo, derived } = fixture();
    const got = [...iterAllRoots([{ dir: repo, isDraft: false, indexDir: indexDirFor(repo, derived) }], 'works')];
    assert.equal(got.length, 1);
    assert.equal(got[0].entry.title, '产物');
    assert.equal(got[0].rootDir, repo);
    assert.equal(got[0].isDraft, false);
    // 不带 indexDir 的旧写法仍读仓内
    assert.deepEqual([...iterAllRoots([{ dir: repo, isDraft: false }], 'works')].map((x) => x.entry.title), ['仓内']);
});
