/**
 * production-dir.test.mjs — 正式仓缺失时必须报错（overview#432）。
 *
 *   node --test scripts/lib/production-dir.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertProductionDir, assertSiteContentFiles, SITE_CONTENT_FILES } from './production-dir.mjs';

const SCRIPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const NEXTJS_DIR = join(SCRIPTS_DIR, '..');

function withTmp(fn) {
    const base = mkdtempSync(join(tmpdir(), 'prod-dir-'));
    try { return fn(base); } finally { rmSync(base, { recursive: true, force: true }); }
}

test('assertProductionDir：目录不存在 → 抛错', () => {
    withTmp((base) => assert.throws(() => assertProductionDir(join(base, 'book-index')), /不存在/));
});

test('assertProductionDir：没有 index/ → 抛错', () => {
    withTmp((base) => assert.throws(() => assertProductionDir(base), /index\//));
});

test('assertProductionDir：有 index/ → 通过', () => {
    withTmp((base) => {
        mkdirSync(join(base, 'index'));
        assertProductionDir(base);
    });
});

test('assertSiteContentFiles：缺文件 → 抛错并列出缺哪几个', () => {
    withTmp((base) => {
        writeFileSync(join(base, 'resource.json'), '{}');
        assert.throws(() => assertSiteContentFiles(base), (e) => /recommended\.json/.test(e.message) && /promotions\.json/.test(e.message) && !/resource\.json、/.test(e.message));
    });
});

test('assertSiteContentFiles：promotions.json 换成 promotions/ 分片目录（bim#139）→ 也通过；两者都没有 → 报缺并提示分片目录', () => {
    withTmp((base) => {
        for (const f of SITE_CONTENT_FILES.filter((x) => x !== 'promotions.json')) writeFileSync(join(base, f), '{}');
        assert.throws(() => assertSiteContentFiles(base), (e) => /promotions\.json/.test(e.message) && /promotions\/ 分片目录/.test(e.message));
        mkdirSync(join(base, 'promotions'));
        assertSiteContentFiles(base);
    });
});

test('assertSiteContentFiles：齐全 → 通过', () => {
    withTmp((base) => {
        for (const f of SITE_CONTENT_FILES) writeFileSync(join(base, f), '{}');
        assertSiteContentFiles(base);
    });
});

function runBundle(env) {
    return spawnSync(process.execPath, [join(SCRIPTS_DIR, 'bundle-data.mjs')], {
        cwd: NEXTJS_DIR, env: { ...process.env, ...env }, encoding: 'utf-8',
    });
}

test('bundle-data.mjs：正式仓不存在 → 非 0 退出，不静默', () => {
    withTmp((base) => {
        const r = runBundle({ KYG_DATA_ROOT: join(base, 'out'), BOOK_INDEX_PRODUCTION_DIR: join(base, 'book-index'), BOOK_TEXT_DIR: join(base, 'text') });
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /book-index（正式仓）目录不存在/);
    });
});

test('bundle-data.mjs：正式仓缺站点内容文件 → 非 0 退出', () => {
    withTmp((base) => {
        mkdirSync(join(base, 'book-index', 'index'), { recursive: true });
        const r = runBundle({ KYG_DATA_ROOT: join(base, 'out'), BOOK_INDEX_PRODUCTION_DIR: join(base, 'book-index'), BOOK_TEXT_DIR: join(base, 'text') });
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /缺站点内容文件/);
    });
});
