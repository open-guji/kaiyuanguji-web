#!/usr/bin/env node
/**
 * bundle-data-work-fulltext.test.mjs — Work 全文进数据桶（W6b）的脚本单测
 * （不进 jest，同 data-dirs.test.mjs／h1-orphans.test.mjs 一套写法）。
 *
 * 背景：book-index-ui（bim/ui）W6a 加了 BundleStorage.getWorkFullTextList／
 * Index／Chapter 三个读方法，读的路径是：
 *   - index/full_text/{0-f}.json      book-text 的 16 个分片原样拷过来（全局清单）
 *   - items/<workId>/full_text/<key>/index.json 与 <file>.txt（.md 改名）
 * bundle-data.mjs 原来只探测 Book 全文（has_full_text 标记，flat 无 <key> 层），
 * 没有拷这份全局清单，三个读方法因此全部取空。
 *
 * 覆盖：
 *   1. index/full_text/*.json：book-text 有这份清单时原样拷到产物，内容逐字节一致；
 *      book-text 没有这份目录时不报错、跳过（旧仓兼容）。
 *   2. items/<workId>/full_text/<key>/：Work 可以有多个来源 key（如老子有
 *      wikisource-01／wikisource-02 两个版本），每个 key 下的 index.json 与
 *      各章都要复制，.md 改 .txt——这条走的是 bundleL1() 里对 collated_edition
 *      同一套 copyDirRecursive，本测试只是把 Work 全文场景也纳入回归。
 *   3. 不影响 Book 全文（flat，无 <key> 层）：已有产物不受影响。
 *
 * 用法：node scripts/bundle-data-work-fulltext.test.mjs
 */

import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NEXTJS_DIR = join(__dirname, '..');

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

function git(cwd, ...args) {
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'ignore' });
}

/**
 * 造一份最小 draft + text 仓：
 *   - 一个 Work（多来源全文：wikisource-01／wikisource-02，模拟老子两个版本）
 *   - 一个 Book（flat 全文，回归不受影响）
 *   - book-text 顶层 index/full_text/{0,1}.json 两片全局清单
 */
function makeFixture(base) {
    const draft = join(base, 'draft');
    const text = join(base, 'text');
    const workId = 'aaaaaaaaaaa';
    const bookId = 'bbbbbbbbbbb';
    const emptyBookId = 'ccccccccccc'; // full_text/index.json 在但 chapters 为空
    const workRel = `Work/a/a/a/${workId}-老子.json`;
    const bookRel = `Book/b/b/b/${bookId}-某刻本.json`;
    const emptyBookRel = `Book/c/c/c/${emptyBookId}-空目录本.json`;

    mkdirSync(join(draft, 'index', 'works'), { recursive: true });
    mkdirSync(join(draft, 'index', 'books'), { recursive: true });
    mkdirSync(join(draft, dirname(workRel)), { recursive: true });
    mkdirSync(join(draft, dirname(bookRel)), { recursive: true });
    mkdirSync(join(draft, dirname(emptyBookRel)), { recursive: true });
    writeFileSync(join(draft, 'index', 'works', '0.json'),
        JSON.stringify({ [workId]: { id: workId, name: '老子', type: 'work', path: workRel } }));
    writeFileSync(join(draft, 'index', 'books', '0.json'),
        JSON.stringify({
            [bookId]: { id: bookId, name: '某刻本', type: 'book', path: bookRel },
            [emptyBookId]: { id: emptyBookId, name: '空目录本', type: 'book', path: emptyBookRel },
        }));
    writeFileSync(join(draft, workRel), JSON.stringify({ id: workId, title: '老子', type: 'work' }));
    writeFileSync(join(draft, bookRel), JSON.stringify({ id: bookId, title: '某刻本', type: 'book' }));
    writeFileSync(join(draft, emptyBookRel), JSON.stringify({ id: emptyBookId, title: '空目录本', type: 'book' }));

    // Work 全文：两个来源 key，各一章
    for (const key of ['wikisource-01', 'wikisource-02']) {
        const dir = join(text, dirname(workRel), workId, 'full_text', key);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'index.json'), JSON.stringify({ chapters: [{ file: '001.md', title: '第一章' }], key }));
        writeFileSync(join(dir, '001.md'), `# ${key} 第一章\n道可道，非常道。\n`);
    }

    // Book 全文：flat，无 <key> 层（回归对照组）
    const bookFtDir = join(text, dirname(bookRel), bookId, 'full_text');
    mkdirSync(bookFtDir, { recursive: true });
    writeFileSync(join(bookFtDir, 'index.json'), JSON.stringify({ chapters: [{ file: '001.md', title: '第一章' }] }));
    writeFileSync(join(bookFtDir, '001.md'), '# 第一回\n某某某。\n');

    const emptyFtDir = join(text, dirname(emptyBookRel), emptyBookId, 'full_text');
    mkdirSync(emptyFtDir, { recursive: true });
    writeFileSync(join(emptyFtDir, 'index.json'), JSON.stringify({ chapters: [] }));

    // book-text 顶层全局清单：两片，workId 分到片 'a'
    const globalDir = join(text, 'index', 'full_text');
    mkdirSync(globalDir, { recursive: true });
    const shardEntry = [
        { key: 'wikisource-01', owner_type: 'Work', path: `${dirname(workRel)}/${workId}/full_text/wikisource-01`, version_label: '王弼本', source_name: '維基文庫', total_chapters: 1, primary: true },
        { key: 'wikisource-02', owner_type: 'Work', path: `${dirname(workRel)}/${workId}/full_text/wikisource-02`, version_label: '河上公本', source_name: '維基文庫', total_chapters: 1, primary: false },
    ];
    writeFileSync(join(globalDir, 'a.json'), JSON.stringify({ [workId]: shardEntry }));
    writeFileSync(join(globalDir, 'b.json'), JSON.stringify({}));

    git(draft, 'init', '-q');
    git(draft, 'add', '-A');
    git(draft, 'commit', '-q', '-m', 'fixture');

    return { draft, text, workId, bookId, emptyBookId, shardEntry };
}

function runBundleData(env) {
    return execFileSync('node', [join(NEXTJS_DIR, 'scripts', 'bundle-data.mjs')], {
        cwd: NEXTJS_DIR,
        env,
        stdio: 'pipe',
        encoding: 'utf-8',
    });
}

function baseEnv(outRoot, draft, text) {
    const env = {
        ...process.env,
        KYG_DATA_ROOT: outRoot,
        BOOK_INDEX_DRAFT_DIR: draft,
        BOOK_INDEX_PRODUCTION_DIR: join(outRoot, '..', 'no-production'),
        BOOK_TEXT_DIR: text,
    };
    for (const k of ['DATA_OUT_DIR', 'DATA_LATEST_FILE', 'H1_OUT_DIR', 'H1_TEXT_OUT_DIR']) delete env[k];
    return env;
}

const tmp = mkdtempSync(join(tmpdir(), 'w6b-bundle-'));
try {
    const { draft, text, workId, bookId, emptyBookId, shardEntry } = makeFixture(tmp);
    const outRoot = join(tmp, 'kyg-data');
    const env = baseEnv(outRoot, draft, text);

    let stdout = '';
    test('bundle-data.mjs 正常跑完（有 book-text/index/full_text/ 时）', () => {
        stdout = runBundleData(env);
    });

    test('index/full_text/*.json：两片原样拷到产物，内容逐字节一致', () => {
        const destA = join(outRoot, 'data', 'index', 'full_text', 'a.json');
        const destB = join(outRoot, 'data', 'index', 'full_text', 'b.json');
        assert.ok(existsSync(destA), 'a.json 应存在');
        assert.ok(existsSync(destB), 'b.json 应存在');
        const parsed = JSON.parse(readFileSync(destA, 'utf-8'));
        assert.deepEqual(parsed[workId], shardEntry, '内容应与 book-text 源文件逐字节等价（JSON 结构相同）');
    });

    test('WFT 日志行报了 2 个分片（不多不少，只拷存在的两片）', () => {
        assert.match(stdout, /WFT\s+2 index\/full_text 分片/);
    });

    test('items/<workId>/full_text/<key>/：两个来源 key 都进产物，.md 改 .txt', () => {
        for (const key of ['wikisource-01', 'wikisource-02']) {
            const idxPath = join(outRoot, 'data', 'items', workId, 'full_text', key, 'index.json');
            const chapterTxt = join(outRoot, 'data', 'items', workId, 'full_text', key, '001.txt');
            const chapterMd = join(outRoot, 'data', 'items', workId, 'full_text', key, '001.md');
            assert.ok(existsSync(idxPath), `${key}/index.json 应存在`);
            assert.ok(existsSync(chapterTxt), `${key}/001.txt 应存在（.md 改名）`);
            assert.ok(!existsSync(chapterMd), `${key}/001.md 不应残留`);
            assert.match(readFileSync(chapterTxt, 'utf-8'), /道可道，非常道/);
        }
    });

    test('Book 全文（flat，无 <key> 层）不受影响：仍是回归对照组', () => {
        const idxPath = join(outRoot, 'data', 'items', bookId, 'full_text', 'index.json');
        const chapterTxt = join(outRoot, 'data', 'items', bookId, 'full_text', '001.txt');
        assert.ok(existsSync(idxPath));
        assert.ok(existsSync(chapterTxt));
    });

    test('条目 JSON 的阅读标记：Work 有全文标 has_site_fulltext；Book 按 chapters 非空标 has_full_text（空目录的不标）', () => {
        const entry = (id) => JSON.parse(readFileSync(join(outRoot, 'data', 'entry', `${id}.json`), 'utf-8'));
        assert.equal(entry(workId).has_site_fulltext, true);
        assert.equal(entry(bookId).has_full_text, true);
        assert.equal(entry(emptyBookId).has_full_text, undefined);
    });

    test('book-text 无 index/full_text/ 目录时：跳过，不报错、不建空目录', () => {
        rmSync(join(text, 'index', 'full_text'), { recursive: true, force: true });
        const outRoot2 = join(tmp, 'kyg-data-2');
        const env2 = baseEnv(outRoot2, draft, text);
        const out = runBundleData(env2);
        assert.match(out, /WFT\s+skipped/);
        assert.ok(!existsSync(join(outRoot2, 'data', 'index', 'full_text')));
    });
} finally {
    rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed${process.exitCode ? '，有失败' : ''}`);
