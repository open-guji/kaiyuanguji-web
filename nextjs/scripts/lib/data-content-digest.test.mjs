/**
 * lib/data-content-digest.mjs 单测（overview#322：cacheKey 并进产物内容摘要）。
 * 跑法：cd nextjs && node --test scripts/lib/data-content-digest.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeDataContentDigest } from './data-content-digest.mjs';

function makeDir(files) {
    const dir = mkdtempSync(join(tmpdir(), 'kyg-digest-'));
    for (const [rel, body] of Object.entries(files)) {
        const full = join(dir, rel);
        mkdirSync(join(full, '..'), { recursive: true });
        writeFileSync(full, body);
    }
    return dir;
}
const FILES = {
    'meta.json': '{"works":1}',
    'meta-home/sections.json': '{"shelf":null}',
    'catalog/a/1.json': '[1,2]',
    'version.json': JSON.stringify({ commitId: 'abc', bundleDate: '2026-10-01T00:00:00Z' }),
    'search/meta.json': JSON.stringify({ version: 5, builtAt: '2026-10-01T00:00:00Z', indices: [{ type: 'work', buildMs: 74 }] }),
};

test('同样的内容：摘要一样（与创建顺序、mtime 无关）', () => {
    const a = makeDir(FILES);
    const b = makeDir(Object.fromEntries(Object.entries(FILES).reverse()));
    utimesSync(join(b, 'meta.json'), new Date(2000, 0, 1), new Date(2000, 0, 1));
    try {
        assert.equal(computeDataContentDigest(a), computeDataContentDigest(b));
        assert.match(computeDataContentDigest(a), /^[0-9a-f]{16}$/);
    } finally { rmSync(a, { recursive: true }); rmSync(b, { recursive: true }); }
});

test('任何一个产物文件的内容变了：摘要变（派生文件改了、数据仓没动 = 本案）', () => {
    const a = makeDir(FILES);
    const b = makeDir({ ...FILES, 'meta-home/sections.json': '{"shelf":{"items":[1]}}' });
    try {
        assert.notEqual(computeDataContentDigest(a), computeDataContentDigest(b));
    } finally { rmSync(a, { recursive: true }); rmSync(b, { recursive: true }); }
});

test('文件改名、新增、删除：摘要变', () => {
    const base = makeDir(FILES);
    const renamed = makeDir(Object.fromEntries(Object.entries(FILES).map(([k, v]) => [k === 'meta.json' ? 'meta2.json' : k, v])));
    const added = makeDir({ ...FILES, 'extra.json': '{}' });
    const { 'catalog/a/1.json': _gone, ...rest } = FILES;
    const removed = makeDir(rest);
    try {
        const d = computeDataContentDigest(base);
        for (const other of [renamed, added, removed]) assert.notEqual(computeDataContentDigest(other), d);
    } finally { for (const x of [base, renamed, added, removed]) rmSync(x, { recursive: true }); }
});

test('构建时间戳与耗时（version.json 的 bundleDate、search/meta.json 的 builtAt／buildMs）不影响摘要；其他字段变了仍然影响', () => {
    const a = makeDir(FILES);
    const later = makeDir({
        ...FILES,
        'version.json': JSON.stringify({ commitId: 'abc', bundleDate: '2027-01-01T00:00:00Z' }),
        'search/meta.json': JSON.stringify({ version: 5, builtAt: '2027-01-01T00:00:00Z', indices: [{ type: 'work', buildMs: 999 }] }),
    });
    const otherCommit = makeDir({ ...FILES, 'version.json': JSON.stringify({ commitId: 'zzz', bundleDate: '2026-10-01T00:00:00Z' }) });
    try {
        assert.equal(computeDataContentDigest(a), computeDataContentDigest(later));
        assert.notEqual(computeDataContentDigest(a), computeDataContentDigest(otherCommit));
    } finally { for (const x of [a, later, otherCommit]) rmSync(x, { recursive: true }); }
});

test('时间戳文件解析不了：按原字节算，不抛错', () => {
    const a = makeDir({ ...FILES, 'version.json': 'not json' });
    try {
        assert.match(computeDataContentDigest(a), /^[0-9a-f]{16}$/);
    } finally { rmSync(a, { recursive: true }); }
});
