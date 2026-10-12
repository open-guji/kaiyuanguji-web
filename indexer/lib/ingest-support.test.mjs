import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { acquireLock, manifestProblems, writeState, readState } from './ingest-support.mjs';

const good = () => ({ schema: 1, partial: false, indexerVersion: 'v', commits: { draft: 'a', prod: 'b', text: 'c', derived: 'd' },
    counts: { works: 1, juans: 1, books: 1, collections: 1, entities: 1 },
    sha256: Object.fromEntries(['works', 'juans', 'books', 'collections', 'entities'].map((i) => [i, 'a'.repeat(64)])),
    editionStats: { total: 1, present: 1, positive: 1 } });

test('锁：第二次被占、释放后可再取、死进程的锁被接管', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'lk-')), '.lock');
    const a = acquireLock(p, { run: 1 });
    assert.ok(a.release);
    const b = acquireLock(p);
    assert.equal(b.busy.pid, process.pid);
    a.release();
    const c = acquireLock(p); assert.ok(c.release); c.release();
    writeFileSync(p, JSON.stringify({ pid: 2 ** 22 + 12345, host: hostname() }));
    const d = acquireLock(p); assert.ok(d.release, '死进程应被接管'); d.release();
});

test('manifest 校验', () => {
    assert.deepEqual(manifestProblems(good()), []);
    assert.ok(manifestProblems({ ...good(), partial: true }).some((s) => s.includes('partial')));
    const m = good(); m.commits.text = null;
    assert.ok(manifestProblems(m).some((s) => s.includes('commits.text')));
    const m2 = good(); delete m2.sha256.works;
    assert.ok(manifestProblems(m2).some((s) => s.includes('sha256.works')));
    assert.ok(manifestProblems({ ...good(), schema: 2 }).length);
});

test('state 原子写留 .prev', () => {
    const p = join(mkdtempSync(join(tmpdir(), 'st-')), 'state.json');
    writeState(p, { n: 1 }); writeState(p, { n: 2 });
    assert.equal(readState(p).n, 2);
    assert.equal(readState(`${p}.prev`).n, 1);
    assert.equal(existsSync(`${p}.tmp`), false);
});

test('锁：空的锁文件超过 60 秒视为陈旧并接管；新建的空锁仍算被占', async () => {
    const { utimesSync } = await import('node:fs');
    const p = join(mkdtempSync(join(tmpdir(), 'lk-')), '.lock');
    writeFileSync(p, '');
    assert.ok(acquireLock(p).busy);
    const old = new Date(Date.now() - 120_000);
    utimesSync(p, old, old);
    const l = acquireLock(p); assert.ok(l.release); l.release();
});

test('manifest：没有 text commit 时，只入非 juans 索引仍通过', () => {
    const m = good(); m.commits.text = null;
    assert.deepEqual(manifestProblems(m, { requireIndexes: ['works', 'books'] }), []);
    assert.ok(manifestProblems(m).some((x) => x.includes('commits.text')));
});

test('insideRoot：../ 越界被拒', async () => {
    const { insideRoot } = await import('./shards.mjs');
    const { resolve } = await import('node:path');
    assert.ok(insideRoot('/a/b', resolve('/a/b', 'x/y.json')));
    assert.ok(!insideRoot('/a/b', resolve('/a/b', '../c/y.json')));
    assert.ok(!insideRoot('/a/b', resolve('/a/bc/y.json')));
});
