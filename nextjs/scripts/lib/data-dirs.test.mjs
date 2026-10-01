#!/usr/bin/env node
/**
 * data-dirs.test.mjs — 数据产物目录可配（S2）的脚本单测（不进 jest，与
 * h1-orphans.test.mjs 同一套写法）。
 *
 * 三部分：
 *   1. resolveDataDirs() 纯函数：不设环境变量时与改动前的 public/ 路径逐一相等；
 *      设了根目录／单项变量时按优先级解析。
 *   2. 静态检查：scripts/*.mjs 里不再有写死的 public/data* 产物路径。
 *   3. 端到端：用假的 draft／text 仓，在 KYG_DATA_ROOT 指向的临时目录里依次跑
 *      bundle-data → bundle-hashed → bundle-hashed-text → 两个 parity 校验，
 *      确认产物全落在临时目录、nextjs/public/ 下的产物目录一个字节都没动。
 *
 * 用法：node scripts/lib/data-dirs.test.mjs
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveDataDirs, DEFAULT_DATA_ROOT } from './data-dirs.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NEXTJS_DIR = resolve(__dirname, '..', '..');
const SCRIPTS_DIR = join(NEXTJS_DIR, 'scripts');
const PUBLIC_DIR = join(NEXTJS_DIR, 'public');

let passed = 0;
function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (e) {
        console.error(`  ✗ ${name}`);
        console.error(`    ${e.stack || e.message}`);
        process.exitCode = 1;
    }
}

// ─── 1. 纯函数 ───

console.log('resolveDataDirs');

test('不设任何变量：与改动前写死的 public/ 路径逐一相等', () => {
    const d = resolveDataDirs({});
    assert.equal(DEFAULT_DATA_ROOT, PUBLIC_DIR);
    assert.equal(d.root, PUBLIC_DIR);
    assert.equal(d.dataDir, join(PUBLIC_DIR, 'data'));
    assert.equal(d.latestFile, join(PUBLIC_DIR, 'latest.json'));
    assert.equal(d.h1Dir, join(PUBLIC_DIR, 'data-h1'));
    assert.equal(d.h1TextDir, join(PUBLIC_DIR, 'data-h1-text'));
});

test('空字符串／纯空白视同未设（CI 里 `X: ${{ vars.Y }}` 取空时不误指到 cwd）', () => {
    const d = resolveDataDirs({ KYG_DATA_ROOT: '', DATA_OUT_DIR: '  ', H1_OUT_DIR: '' });
    assert.deepEqual(d, resolveDataDirs({}));
});

test('KYG_DATA_ROOT：四项一起挪到根目录下', () => {
    const d = resolveDataDirs({ KYG_DATA_ROOT: '/tmp/kyg-data' });
    assert.equal(d.root, '/tmp/kyg-data');
    assert.equal(d.dataDir, '/tmp/kyg-data/data');
    assert.equal(d.latestFile, '/tmp/kyg-data/latest.json');
    assert.equal(d.h1Dir, '/tmp/kyg-data/data-h1');
    assert.equal(d.h1TextDir, '/tmp/kyg-data/data-h1-text');
});

test('单项变量优先于根目录', () => {
    const d = resolveDataDirs({
        KYG_DATA_ROOT: '/r',
        DATA_OUT_DIR: '/a/data',
        DATA_LATEST_FILE: '/b/latest.json',
        H1_OUT_DIR: '/c/h1',
        H1_TEXT_OUT_DIR: '/d/h1t',
    });
    assert.equal(d.dataDir, '/a/data');
    assert.equal(d.latestFile, '/b/latest.json');
    assert.equal(d.h1Dir, '/c/h1');
    assert.equal(d.h1TextDir, '/d/h1t');
});

test('只设 DATA_OUT_DIR：latest.json 跟到 data/ 同级（保持改动前的相对位置）', () => {
    const d = resolveDataDirs({ DATA_OUT_DIR: '/x/y/data' });
    assert.equal(d.latestFile, '/x/y/latest.json');
    assert.equal(d.h1Dir, join(PUBLIC_DIR, 'data-h1'));
});

test('只设 H1_OUT_DIR（A3 原有用法）：其余仍在 public/', () => {
    const d = resolveDataDirs({ H1_OUT_DIR: '/h1' });
    assert.equal(d.h1Dir, '/h1');
    assert.equal(d.dataDir, join(PUBLIC_DIR, 'data'));
    assert.equal(d.h1TextDir, join(PUBLIC_DIR, 'data-h1-text'));
});

test('相对路径按 cwd 解析为绝对路径', () => {
    const d = resolveDataDirs({ KYG_DATA_ROOT: 'rel/root' });
    assert.equal(d.root, resolve('rel/root'));
    assert.equal(d.dataDir, resolve('rel/root/data'));
});

// ─── 2. 静态检查 ───

console.log('\n脚本里不再写死产物路径');

test("scripts/*.mjs 不再出现 'public', 'data…' 形式的产物路径", () => {
    const offenders = [];
    for (const f of readdirSync(SCRIPTS_DIR)) {
        if (!f.endsWith('.mjs')) continue;
        const src = readFileSync(join(SCRIPTS_DIR, f), 'utf-8');
        if (/'public',\s*'data/.test(src) || /'public',\s*'latest\.json'/.test(src)) offenders.push(f);
    }
    assert.deepEqual(offenders, []);
});

// ─── 3. 端到端 ───

console.log('\n端到端：KYG_DATA_ROOT 指向临时目录');

/** public/ 下产物目录的快照：路径 → mtime（不存在记 null） */
function snapshotPublic() {
    const snap = {};
    for (const name of ['data', 'data-h1', 'data-h1-text', 'latest.json']) {
        const p = join(PUBLIC_DIR, name);
        snap[name] = existsSync(p) ? statSync(p).mtimeMs : null;
    }
    return snap;
}

function makeFixture(base) {
    const draft = join(base, 'draft');
    const text = join(base, 'text');
    const id = 'aaaaaaaaaaa';
    const rel = `Work/a/b/c/${id}-測試.json`;
    mkdirSync(join(draft, 'index', 'works'), { recursive: true });
    mkdirSync(join(draft, dirname(rel)), { recursive: true });
    writeFileSync(join(draft, 'index', 'works', '0.json'),
        JSON.stringify({ [id]: { id, name: '測試', type: 'work', path: rel } }));
    writeFileSync(join(draft, rel), JSON.stringify({ id, title: '測試', type: 'work' }));
    // 阅读文本：manifest.json＋default/{index.json,001.md}（overview#307）
    const item = join(text, dirname(rel), id);
    mkdirSync(join(item, 'default'), { recursive: true });
    writeFileSync(join(item, 'manifest.json'), JSON.stringify({ id, versions: [{ key: 'default', kind: 'transcription', label: '維基文庫', source: 'wikisource', license: 'CC BY-SA 4.0' }] }));
    writeFileSync(join(item, 'default', 'index.json'), JSON.stringify({ chapters: [{ n: 1, file: '001', title: '卷一', has_json: false }] }));
    writeFileSync(join(item, 'default', '001.md'), '# 卷一\n測試正文\n');
    // bundle-data 从 draft 仓取 commitId
    const git = (...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: draft, stdio: 'ignore' });
    git('init', '-q');
    git('add', '-A');
    git('commit', '-q', '-m', 'fixture');
    return { draft, text, id };
}

const tmp = mkdtempSync(join(tmpdir(), 's2-data-dirs-'));
try {
    const { draft, text, id } = makeFixture(tmp);
    const outRoot = join(tmp, 'kyg-data');
    const env = {
        ...process.env,
        KYG_DATA_ROOT: outRoot,
        BOOK_INDEX_DRAFT_DIR: draft,
        BOOK_INDEX_PRODUCTION_DIR: join(tmp, 'no-production'),
        BOOK_TEXT_DIR: text,
    };
    // 防止外部环境里残留的单项变量把产物引到别处
    for (const k of ['DATA_OUT_DIR', 'DATA_LATEST_FILE', 'H1_OUT_DIR', 'H1_TEXT_OUT_DIR']) delete env[k];
    const run = (script) => execFileSync('node', [join(SCRIPTS_DIR, script)], { cwd: NEXTJS_DIR, env, stdio: 'pipe' });

    const before = snapshotPublic();

    test('bundle-data.mjs：data/ 与 latest.json 写到 KYG_DATA_ROOT', () => {
        run('bundle-data.mjs');
        assert.ok(existsSync(join(outRoot, 'data', 'entry', `${id}.json`)));
        assert.ok(existsSync(join(outRoot, 'data', 'version.json')));
        assert.ok(existsSync(join(outRoot, 'data', 'search', 'meta.json')), 'build-search-index 子进程也应写到同一目录');
        assert.ok(existsSync(join(outRoot, 'data', 'items', id, 'default', '001.txt')), 'items/ 应复制过来（.md 改名 .txt）');
        assert.ok(existsSync(join(outRoot, 'latest.json')));
    });

    test('bundle-hashed.mjs：从 KYG_DATA_ROOT/data 读、写到 KYG_DATA_ROOT/data-h1', () => {
        run('bundle-hashed.mjs');
        assert.ok(existsSync(join(outRoot, 'data-h1', 'manifest-root.json')));
        assert.ok(readdirSync(join(outRoot, 'data-h1', 'entry')).some(f => f.startsWith(`${id}.`)));
    });

    test('bundle-hashed-text.mjs：写到 KYG_DATA_ROOT/data-h1-text', () => {
        run('bundle-hashed-text.mjs');
        assert.ok(existsSync(join(outRoot, 'data-h1-text', 'text-manifest-root.json')));
        assert.ok(existsSync(join(outRoot, 'data-h1-text', 'text', id, 'default')));
    });

    test('verify-hashed-parity／verify-hashed-text-parity：从同一目录读，校验通过', () => {
        run('verify-hashed-parity.mjs');
        run('verify-hashed-text-parity.mjs');
    });

    test('nextjs/public/ 下的产物目录没有被创建或改动', () => {
        assert.deepEqual(snapshotPublic(), before);
    });
} finally {
    rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed${process.exitCode ? '，有失败' : ''}`);
