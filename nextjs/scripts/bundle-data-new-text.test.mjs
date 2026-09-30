#!/usr/bin/env node
/**
 * bundle-data-new-text.test.mjs — 打包层同时认 book-text 新旧两种结构（overview#307 D 块）的脚本单测
 * （不进 jest，同 bundle-data-work-fulltext.test.mjs 一套写法）。
 *
 * 造一份新旧并存的最小 draft + text 仓，真跑 bundle-data.mjs 与 bundle-hashed-text.mjs，核对：
 *   1. 旧结构条目（Work 整理本＋全文、Book 全文）的产物与以前一样：items/<id>/ 下路径、md→txt、条目 JSON 不带 text_* 字段；
 *   2. 新结构条目：manifest.json 与各版本目录进 items/<id>/（md→txt，章 json 原样）；条目 JSON 带 text_count／text_kinds；
 *   3. 私有：manifest 顶层 internal 的条目文本一个字节都不进公开产物；某个 version internal 的，该版本目录不拷、
 *      公开 manifest.json 里也不列；
 *   4. 全局清单 index/texts/{0-f}.json 拷进产物，internal 版本被滤掉（无需过滤的分片字节不变）；
 *   5. 阅读首页 read/：新结构可读条目（含整理本标记）进来，空目录、私有的不进；
 *   6. bundle-hashed-text：新结构条目的 manifest.json 与公开版本目录进 text/<id>/…，manifest 分片里有；私有的没有；
 *   7. 构建期核对（verifyItems）覆盖新结构：产物里缺首章会让 bundle-data 失败。
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

    // 旧结构：Work 有整理本与 Work 全文（全局清单 index/full_text），Book 有全文
    const oldW = addEntry('Work', IDS.oldWork, 'a');
    put(oldW, 'collated_edition/index.json', { juan_files: ['juan/001.json'] });
    put(oldW, 'collated_edition/juan/001.json', { sections: [] });
    put(oldW, 'full_text/wikisource-01/index.json', { chapters: [{ file: '001.md', title: '一' }] });
    put(oldW, 'full_text/wikisource-01/001.md', '# 旧全文\n');
    const oldB = addEntry('Book', IDS.oldBook, 'b');
    put(oldB, 'full_text/index.json', { chapters: [{ file: '001.md', title: '一' }] });
    put(oldB, 'full_text/001.md', '# 旧书全文\n');
    put(text, 'index/full_text/0.json', { [IDS.oldWork]: [{ key: 'wikisource-01', owner_type: 'Work', primary: true, total_chapters: 1 }] });

    // 新结构 Work：default 整理本（章 json）＋维基＋內部的識典
    const nw = addEntry('Work', IDS.newWork, 'c');
    put(nw, 'manifest.json', { id: IDS.newWork, versions: [ver('default', 'collated', { label: '整理本' }), ver('wikisource', 'transcription'), ver('shidian', 'transcription', { visibility: 'internal' })] });
    put(nw, 'default/index.json', idx(true));
    put(nw, 'default/001.md', '# 整理本\n');
    put(nw, 'default/001.json', { sections: [{ title: '一', content: '道可道' }] });
    put(nw, 'wikisource/index.json', idx());
    put(nw, 'wikisource/001.md', '# 维基\n');
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
        [IDS.newWork]: [{ key: 'default', kind: 'collated', label: '整理本', chapters_total: 1 }, { key: 'shidian', kind: 'transcription', label: 'x', chapters_total: 1, visibility: 'internal' }],
        [IDS.privWork]: [{ key: 'default', kind: 'transcription', label: 'x', chapters_total: 1, visibility: 'internal' }],
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
    test('bundle-data.mjs 新旧并存的仓能跑完（含构建期核对）', () => { log = run('bundle-data.mjs', e); });

    test('旧结构条目：items/<id>/ 路径与 md→txt 与以前一致，条目 JSON 没有 text_* 字段', () => {
        assert.ok(existsSync(join(data, 'items', IDS.oldWork, 'collated_edition', 'juan', '001.json')));
        assert.ok(existsSync(join(data, 'items', IDS.oldWork, 'full_text', 'wikisource-01', '001.txt')));
        assert.ok(!existsSync(join(data, 'items', IDS.oldWork, 'manifest.json')));
        assert.ok(existsSync(join(data, 'items', IDS.oldBook, 'full_text', '001.txt')));
        for (const id of [IDS.oldWork, IDS.oldBook]) {
            const entry = readJ(join(data, 'entry', `${id}.json`));
            assert.equal(entry.text_count, undefined);
            assert.equal(entry.text_kinds, undefined);
        }
        assert.equal(readJ(join(data, 'entry', `${IDS.oldWork}.json`)).has_site_fulltext, true);
        assert.equal(readJ(join(data, 'entry', `${IDS.oldBook}.json`)).has_full_text, true);
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

    test('没有 internal 的新结构 manifest.json 原样拷字节', () => {
        const nbSrc = join(text, 'Book', 'f', IDS.newBook, 'manifest.json');
        assert.equal(rd(join(data, 'items', IDS.newBook, 'manifest.json')), rd(nbSrc));
    });

    test('index/texts/{0-f}.json：拷进产物，internal 版本被滤，干净的分片字节不变', () => {
        const s1 = readJ(join(data, 'index', 'texts', '1.json'));
        assert.deepEqual(s1[IDS.newWork].map((v) => v.key), ['default']);
        assert.equal(s1[IDS.privWork], undefined);
        assert.equal(rd(join(data, 'index', 'texts', '2.json')), rd(join(text, 'index', 'texts', '2.json')));
        assert.ok(existsSync(join(data, 'index', 'full_text', '0.json')), '旧的 index/full_text 照旧拷');
    });

    test('阅读首页 read/：新结构可读条目进（含整理本标记），空目录、私有的不进；旧结构照旧', () => {
        const feat = readJ(join(data, 'read', 'featured.json'));
        assert.deepEqual(feat.collated.map((c) => c.id).sort(), [IDS.newWork, IDS.oldWork].sort());
        assert.deepEqual(feat.books.map((c) => c.id).sort(), [IDS.newBook, IDS.oldBook].sort());
        const all = JSON.stringify(readJ(join(data, 'read', 'tree.json')));
        assert.ok(all.length > 0);
        const ids = new Set();
        const tree = readJ(join(data, 'read', 'tree.json'));
        for (const n of tree) for (const f of walkFiles(join(data, 'read', n.id))) for (const c of readJ(join(data, 'read', n.id, f))) ids.add(c.id);
        assert.ok(ids.has(IDS.newWork) && ids.has(IDS.oldWork));
        assert.ok(!ids.has(IDS.emptyWork) && !ids.has(IDS.privWork));
        assert.match(log, /核对 \d+ 项阅读入口的数据文件：全部在产物里/);
    });

    test('bundle-hashed-text：新结构 manifest.json 与公开版本目录进 text/<id>/…，manifest 分片登记；私有的没有；旧结构不变', () => {
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
        // 旧结构仍在老位置
        assert.ok(has(new RegExp(`^${IDS.oldWork}/collated_edition/juan/001\\.[0-9a-f]{8}\\.json$`)));
        assert.ok(has(new RegExp(`^${IDS.oldWork}/full_text/wikisource-01/001\\.[0-9a-f]{8}\\.txt$`)));
        // text-manifest 分片里登记了新结构文件
        const reg = {};
        for (const f of readdirSync(join(h1, 'text-manifest'))) Object.assign(reg, readJ(join(h1, 'text-manifest', f)));
        assert.ok(reg[IDS.newWork]['manifest.json'] && reg[IDS.newWork]['default/001.txt'] && reg[IDS.newWork]['wikisource/001.txt']);
        assert.equal(reg[IDS.privWork], undefined);
        assert.equal(Object.keys(reg[IDS.newWork]).some((k) => k.startsWith('shidian/')), false);
        assert.ok(reg[IDS.oldWork]['collated_edition/index.json']);
    });

    test('构建期核对覆盖新结构：产物里缺首章时 bundle-data 失败并列出', () => {
        // 换一份文本仓：新结构 Work 的 index 登记了 001，但文本仓里没有 001.md
        const tmp2 = mkdtempSync(join(tmpdir(), 'new-text-bad-'));
        try {
            const f2 = makeFixture(tmp2);
            unlinkSync(join(f2.text, 'Work', 'c', IDS.newWork, 'default', '001.md'));
            assert.throws(
                () => run('bundle-data.mjs', env(join(tmp2, 'kyg-data'), f2.draft, f2.text)),
                (err) => /阅读卡片对应的数据文件在产物里缺失/.test(String(err.stderr)) && new RegExp(`${IDS.newWork}: items/${IDS.newWork}/default/001\\.txt`).test(String(err.stderr)),
            );
        } finally {
            rmSync(tmp2, { recursive: true, force: true });
        }
    });
} finally {
    rmSync(tmp, { recursive: true, force: true });
}
console.log(`\n${passed} passed${process.exitCode ? '，有失败' : ''}`);
