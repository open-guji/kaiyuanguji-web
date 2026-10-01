#!/usr/bin/env node
/**
 * bundle-data-new-text.test.mjs — 打包层按 book-text 的 manifest.json＋<key>/ 结构打包（overview#307）的脚本单测
 * （不进 jest，自带最小的 test() 小框架；CI 里由 test.yml 的 node --test 跑）。
 *
 * 造一份最小的 draft + text 仓（外加一个只有旧目录、没有 manifest.json 的条目，验证它不再被当文本），
 * 真跑 bundle-data.mjs 与 bundle-hashed-text.mjs，核对：
 *   1. 没有 manifest.json 的条目目录（旧的 collated_edition／full_text 不再认）：只当非文本资产原样拷，条目 JSON 不带 text_*，不算可读，不进 h1 文本；
 *   2. 新结构条目：manifest.json 与各版本目录进 items/<id>/（md→txt，章 json 原样）；条目 JSON 带 text_count／text_kinds；
 *   3. 私有：manifest 顶层 internal 的条目文本一个字节都不进公开产物；某个 version internal 的，该版本目录不拷、
 *      公开 manifest.json 里也不列；
 *   4. 全局清单 index/texts/{0-f}.json 拷进产物，internal 版本被滤掉（无需过滤的分片字节不变）；
 *   5. 阅读首页 read/：有 manifest.json 的可读条目（含整理本标记）进来，空目录、私有的、没有 manifest 的不进；
 *   6. bundle-hashed-text：新结构条目的 manifest.json 与公开版本目录进 text/<id>/…，manifest 分片里有；私有的没有；
 *   7. 构建期核对（verifyItems）：首章没有 json 也没有 md、或 has_json 的首章 json 缺了，bundle-data 失败；has_json 的首章只有 json（md 可缺）不算缺。
 *
 * 用法：node scripts/bundle-data-new-text.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const NEXTJS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

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

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'ignore' });
const put = (root, rel, data) => {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data));
};
const ver = (key, kind, extra = {}) => ({ key, kind, label: key, source: key, source_name: key, license: null, quality: null, chapters_total: 1, ...extra });
const idx = (hasJson = false, ...stems) => ({ chapters: (stems.length ? stems : ['001']).map((f, i) => ({ n: i + 1, file: f, title: `卷${i + 1}`, has_json: hasJson })) });

const IDS = { oldWork: 'aaaaaaaaaaa', oldBook: 'bbbbbbbbbbb', newWork: 'ccccccccccc', privWork: 'ddddddddddd', emptyWork: 'eeeeeeeeeee', newBook: 'fffffffffff' };

function makeFixture(base) {
    const draft = join(base, 'draft');
    const text = join(base, 'text');
    const works = {};
    const books = {};
    const addEntry = (kind, id, sub) => {
        const rel = `${kind}/${sub}/${id}-x.json`;
        put(draft, rel, { id, title: `書${id}`, type: kind.toLowerCase() });
        (kind === 'Work' ? works : books)[id] = { id, name: `書${id}`, type: kind.toLowerCase(), path: rel };
        return join(text, dirname(rel), id); // 文本仓里的条目目录
    };

    // 没有 manifest.json 的旧目录（2026-09-30 已迁移掉的旧结构）：现在只当普通目录，不再认作文本
    const oldW = addEntry('Work', IDS.oldWork, 'a');
    put(oldW, 'collated_edition/index.json', { juan_files: ['juan/001.json'] });
    put(oldW, 'collated_edition/juan/001.json', { sections: [] });
    put(oldW, 'full_text/wikisource-01/index.json', { chapters: [{ file: '001.md', title: '一' }] });
    put(oldW, 'full_text/wikisource-01/001.md', '# 旧全文\n');
    const oldB = addEntry('Book', IDS.oldBook, 'b');
    put(oldB, 'full_text/index.json', { chapters: [{ file: '001.md', title: '一' }] });
    put(oldB, 'full_text/001.md', '# 旧书全文\n');

    // 新结构 Work：default 整理本（章 json）＋维基＋內部的識典
    const nw = addEntry('Work', IDS.newWork, 'c');
    put(nw, 'manifest.json', { id: IDS.newWork, versions: [ver('default', 'collated', { label: '整理本' }), ver('wikisource', 'transcription'), ver('shidian', 'transcription', { visibility: 'internal' })] });
    put(nw, 'default/index.json', idx(true));
    put(nw, 'default/001.md', '# 整理本\n');
    put(nw, 'default/001.json', { sections: [{ title: '一', content: '道可道' }] });
    put(nw, 'wikisource/index.json', idx());
    put(nw, 'wikisource/001.md', '# 维基\n');
    put(nw, 'fragments/f.json', { x: 1 }); // 非文本资产照旧公开
    put(nw, 'lineage_graph.json', { nodes: [] });
    put(nw, 'extra/index.json', idx()); // manifest 没列的文本版本目录：不公开
    put(nw, 'extra/001.md', '# 未登记\n');
    put(nw, 'shidian/index.json', idx());
    put(nw, 'shidian/001.md', '# 私有識典\n');
    // 新结构 Work：顶层 internal，整条目文本都不公开
    const pw = addEntry('Work', IDS.privWork, 'd');
    put(pw, 'manifest.json', { id: IDS.privWork, visibility: 'internal', versions: [ver('default', 'transcription')] });
    put(pw, 'default/index.json', idx());
    put(pw, 'default/001.md', '# 私有\n');
    // 新结构 Work：default 章目录为空，不可读
    const ew = addEntry('Work', IDS.emptyWork, 'e');
    put(ew, 'manifest.json', { id: IDS.emptyWork, versions: [ver('default', 'transcription')] });
    put(ew, 'default/index.json', { chapters: [] });
    // 新结构 Book
    const nb = addEntry('Book', IDS.newBook, 'f');
    put(nb, 'manifest.json', { id: IDS.newBook, versions: [ver('default', 'transcription')] });
    put(nb, 'default/index.json', idx(false, '001', '002'));
    put(nb, 'default/001.md', '# 新书一\n');
    put(nb, 'default/002.md', '# 新书二\n');

    // 全局清单 index/texts：一片含 internal 版本（要被滤），一片干净（字节不变）
    put(text, 'index/texts/1.json', {
        [IDS.newWork]: [{ key: 'default', kind: 'collated', label: '整理本', chapters_total: 1 }, { key: 'shidian', kind: 'transcription', label: 'x', chapters_total: 1 }],
        [IDS.privWork]: [{ key: 'default', kind: 'transcription', label: 'x', chapters_total: 1 }], // 清单里没标 visibility，靠条目 manifest 判
    });
    put(text, 'index/texts/2.json', { [IDS.newBook]: [{ key: 'default', kind: 'transcription', label: 'x', chapters_total: 2 }] });

    put(draft, 'index/works/0.json', works);
    put(draft, 'index/books/0.json', books);
    git(draft, 'init', '-q');
    git(draft, 'add', '-A');
    git(draft, 'commit', '-q', '-m', 'fixture');
    return { draft, text };
}

function env(outRoot, draft, text) {
    const e = { ...process.env, KYG_DATA_ROOT: outRoot, BOOK_INDEX_DRAFT_DIR: draft, BOOK_INDEX_PRODUCTION_DIR: join(outRoot, '..', 'no-production'), BOOK_TEXT_DIR: text };
    for (const k of ['DATA_OUT_DIR', 'DATA_LATEST_FILE', 'H1_OUT_DIR', 'H1_TEXT_OUT_DIR']) delete e[k];
    return e;
}
const run = (script, e) => execFileSync('node', [join(NEXTJS_DIR, 'scripts', script)], { cwd: NEXTJS_DIR, env: e, stdio: 'pipe', encoding: 'utf-8' });
const rd = (p) => readFileSync(p, 'utf-8');
const readJ = (p) => JSON.parse(rd(p));
const walkFiles = (dir, base = dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walkFiles(join(dir, d.name), base) : [join(dir, d.name).slice(base.length + 1)]));

const tmp = mkdtempSync(join(tmpdir(), 'new-text-'));
try {
    const { draft, text } = makeFixture(tmp);
    const outRoot = join(tmp, 'kyg-data');
    const e = env(outRoot, draft, text);
    const data = join(outRoot, 'data');
    let log = '';
    test('bundle-data.mjs 能跑完（含构建期核对）', () => { log = run('bundle-data.mjs', e); });

    test('没有 manifest.json 的旧目录：原样拷成普通目录，条目 JSON 没有 text_*／旧阅读标记', () => {
        assert.ok(existsSync(join(data, 'items', IDS.oldWork, 'collated_edition', 'juan', '001.json')));
        assert.ok(!existsSync(join(data, 'items', IDS.oldWork, 'manifest.json')));
        for (const id of [IDS.oldWork, IDS.oldBook]) {
            const entry = readJ(join(data, 'entry', `${id}.json`));
            assert.equal(entry.text_count, undefined);
            assert.equal(entry.text_kinds, undefined);
            assert.equal(entry.has_site_fulltext, undefined);
            assert.equal(entry.has_full_text, undefined);
        }
    });

    test('新结构条目：manifest.json 与版本目录进 items/<id>/（md→txt，章 json 原样），条目 JSON 带 text_count／text_kinds', () => {
        const d = join(data, 'items', IDS.newWork);
        assert.ok(existsSync(join(d, 'manifest.json')));
        assert.ok(existsSync(join(d, 'default', 'index.json')));
        assert.equal(rd(join(d, 'default', '001.txt')), '# 整理本\n');
        assert.ok(!existsSync(join(d, 'default', '001.md')));
        assert.deepEqual(readJ(join(d, 'default', '001.json')), { sections: [{ title: '一', content: '道可道' }] });
        assert.ok(existsSync(join(d, 'wikisource', '001.txt')));
        const entry = readJ(join(data, 'entry', `${IDS.newWork}.json`));
        assert.equal(entry.text_count, 2); // 識典是 internal，不算
        assert.deepEqual(entry.text_kinds, ['collated', 'transcription']);
        assert.equal(readJ(join(data, 'entry', `${IDS.newBook}.json`)).text_count, 1);
        assert.equal(readJ(join(data, 'entry', `${IDS.emptyWork}.json`)).text_count, undefined); // 章目录空
    });

    test('私有：version internal 的目录不拷、公开 manifest 不列它；顶层 internal 的条目文本一个文件都不进公开产物', () => {
        const d = join(data, 'items', IDS.newWork);
        assert.ok(!existsSync(join(d, 'shidian')), 'shidian 目录不应进公开产物');
        const pub = readJ(join(d, 'manifest.json'));
        assert.deepEqual(pub.versions.map((v) => v.key), ['default', 'wikisource']);
        assert.ok(!JSON.stringify(pub).includes('shidian'));
        const p = join(data, 'items', IDS.privWork);
        assert.ok(!existsSync(join(p, 'manifest.json')));
        assert.ok(!existsSync(join(p, 'default')));
        // 整个公开产物里搜不到私有正文
        for (const f of walkFiles(data)) {
            if (/\.(txt|json)$/.test(f)) assert.ok(!rd(join(data, f)).includes('私有'), `${f} 含私有正文`);
        }
        assert.match(log, /visibility=internal 的文本版本未进公开产物/);
    });

    test('新结构条目里非文本资产（fragments、lineage_graph.json）照旧公开；manifest 没列的文本版本目录不公开', () => {
        const d = join(data, 'items', IDS.newWork);
        assert.ok(existsSync(join(d, 'fragments', 'f.json')));
        assert.ok(existsSync(join(d, 'lineage_graph.json')));
        assert.ok(!existsSync(join(d, 'extra')), '未登记的 extra/ 不应公开');
    });

    test('没有 internal 的新结构 manifest.json 原样拷字节', () => {
        const nbSrc = join(text, 'Book', 'f', IDS.newBook, 'manifest.json');
        assert.equal(rd(join(data, 'items', IDS.newBook, 'manifest.json')), rd(nbSrc));
    });

    test('index/texts/{0-f}.json：拷进产物，按条目 manifest 滤掉私有（清单里没标也滤），干净的分片字节不变', () => {
        const s1 = readJ(join(data, 'index', 'texts', '1.json'));
        assert.deepEqual(s1[IDS.newWork].map((v) => v.key), ['default']);
        assert.equal(s1[IDS.privWork], undefined);
        assert.equal(rd(join(data, 'index', 'texts', '2.json')), rd(join(text, 'index', 'texts', '2.json')));
        assert.ok(!existsSync(join(data, 'index', 'full_text')), '旧的 index/full_text 不再拷');
    });

    test('阅读首页 read/：新结构可读条目进（含整理本标记），空目录、私有的、没有 manifest 的不进（overview#307 §十）', () => {
        const feat = readJ(join(data, 'read', 'featured.json'));
        assert.deepEqual(feat.collated.map((c) => c.id), [IDS.newWork]);
        assert.deepEqual(feat.books.map((c) => c.id), [IDS.newBook]);
        const all = JSON.stringify(readJ(join(data, 'read', 'tree.json')));
        assert.ok(all.length > 0);
        const ids = new Set();
        const tree = readJ(join(data, 'read', 'tree.json'));
        for (const n of tree) for (const f of walkFiles(join(data, 'read', n.id))) for (const c of readJ(join(data, 'read', n.id, f))) ids.add(c.id);
        assert.ok(ids.has(IDS.newWork) && !ids.has(IDS.oldWork));
        assert.ok(!ids.has(IDS.emptyWork) && !ids.has(IDS.privWork));
        assert.match(log, /核对 \d+ 项阅读入口的数据文件：全部在产物里/);
    });

    test('bundle-hashed-text：新结构 manifest.json 与公开版本目录进 text/<id>/…，manifest 分片登记；私有的没有；没有 manifest 的旧目录不进', () => {
        run('bundle-hashed-text.mjs', e);
        const h1 = join(outRoot, 'data-h1-text');
        const files = walkFiles(join(h1, 'text')).map((f) => f.replace(/\\/g, '/'));
        const has = (re) => files.some((f) => re.test(f));
        assert.ok(has(new RegExp(`^${IDS.newWork}/manifest\\.[0-9a-f]{8}\\.json$`)));
        assert.ok(has(new RegExp(`^${IDS.newWork}/default/001\\.[0-9a-f]{8}\\.txt$`)));
        assert.ok(has(new RegExp(`^${IDS.newWork}/default/001\\.[0-9a-f]{8}\\.json$`)));
        assert.ok(has(new RegExp(`^${IDS.newWork}/wikisource/index\\.[0-9a-f]{8}\\.json$`)));
        assert.ok(has(new RegExp(`^${IDS.newBook}/default/002\\.[0-9a-f]{8}\\.txt$`)));
        assert.ok(!has(new RegExp(`^${IDS.newWork}/shidian/`)), 'internal 版本不进 h1 文本');
        assert.ok(!has(new RegExp(`^${IDS.privWork}/`)), '顶层 internal 的条目不进 h1 文本');
        assert.ok(!has(new RegExp(`^${IDS.oldWork}/`)), '没有 manifest 的旧目录不进 h1 文本');
        // text-manifest 分片里登记了新结构文件
        const reg = {};
        for (const f of readdirSync(join(h1, 'text-manifest'))) Object.assign(reg, readJ(join(h1, 'text-manifest', f)));
        assert.ok(reg[IDS.newWork]['manifest.json'] && reg[IDS.newWork]['default/001.txt'] && reg[IDS.newWork]['wikisource/001.txt']);
        assert.equal(reg[IDS.privWork], undefined);
        assert.equal(Object.keys(reg[IDS.newWork]).some((k) => k.startsWith('shidian/')), false);
        assert.equal(reg[IDS.oldWork], undefined);
    });

    test('manifest.json 存在但不合法：bundle-data 失败，不当没有文本放过', () => {
        const tmp3 = mkdtempSync(join(tmpdir(), 'new-text-badmanifest-'));
        try {
            const f3 = makeFixture(tmp3);
            writeFileSync(join(f3.text, 'Work', 'c', IDS.newWork, 'manifest.json'), '{ 坏的');
            assert.throws(
                () => run('bundle-data.mjs', env(join(tmp3, 'kyg-data'), f3.draft, f3.text)),
                (err) => /不是合法的 manifest/.test(String(err.stderr)) && String(err.stderr).includes(IDS.newWork),
            );
        } finally {
            rmSync(tmp3, { recursive: true, force: true });
        }
    });

    // 构建期核对：default 版本（整理本，has_json）与 wikisource 版本（没有 has_json）的首章
    const withBad = (mutate, check) => {
        const t = mkdtempSync(join(tmpdir(), 'new-text-bad-'));
        try {
            const f = makeFixture(t);
            mutate(f.text);
            check(() => run('bundle-data.mjs', env(join(t, 'kyg-data'), f.draft, f.text)));
        } finally {
            rmSync(t, { recursive: true, force: true });
        }
    };
    const stderrOf = (err) => String(err.stderr);

    test('构建期核对：has_json 的首章只有 json、没有 md（整理本的 md 可缺）→ 不算缺，bundle-data 照常跑完', () => {
        withBad(
            (text) => unlinkSync(join(text, 'Work', 'c', IDS.newWork, 'default', '001.md')),
            (go) => assert.doesNotThrow(go),
        );
    });

    test('构建期核对：没有 has_json 的版本首章缺 md → bundle-data 失败并列出（.txt）', () => {
        withBad(
            (text) => unlinkSync(join(text, 'Work', 'c', IDS.newWork, 'wikisource', '001.md')),
            (go) => assert.throws(go, (err) => /阅读卡片对应的数据文件在产物里缺失/.test(stderrOf(err)) && new RegExp(`${IDS.newWork}: items/${IDS.newWork}/wikisource/001\\.txt`).test(stderrOf(err))),
        );
    });

    test('构建期核对：has_json 的首章 json 缺了 → bundle-data 失败并列出（.json）；md 在也不行', () => {
        withBad(
            (text) => unlinkSync(join(text, 'Work', 'c', IDS.newWork, 'default', '001.json')),
            (go) => assert.throws(go, (err) => /阅读卡片对应的数据文件在产物里缺失/.test(stderrOf(err)) && new RegExp(`${IDS.newWork}: items/${IDS.newWork}/default/001\\.json`).test(stderrOf(err))),
        );
    });
} finally {
    rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${passed} passed${process.exitCode ? '，有失败' : ''}`);
