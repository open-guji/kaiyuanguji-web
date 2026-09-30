#!/usr/bin/env node
/**
 * build-read-index.test.mjs — 阅读首页可读条目索引的脚本单测（overview#267 第 16 项；
 * 不进 jest，同 build-catalog-index.test.mjs）。
 *
 * 覆盖：可读判定（索引项／详情标记）、卡片字段、排序（整理本在前再按书名）、
 * 与总目同一套节点 id、未分類、被并条目跳过、Book 全文（索引标记与 full_text/index.json 探测）、
 * 写盘结构（featured.json、tree.json、分页）与清旧文件。
 *
 * 用法：node --test scripts/build-read-index.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { nodeIdFor, UNCLASSIFIED_ID } from './build-catalog-index.mjs';
import {
    READ_PAGE_SIZE, bookFirstChapter, bundleRead, collatedFirstJuan, compareReadCards, toReadCard, verifyReadProbes, workFullTextPick,
} from './build-read-index.mjs';

const cls = (l1, l2 = '') => ({ l1, l2, l3: '', l4: '', basis: 'S', source: 'x' });

test('collatedFirstJuan / workFullTextPick / bookFirstChapter：按站内数据判可读', () => {
    const root = mkdtempSync(join(tmpdir(), 'read-probe-'));
    try {
        const w = (rel, data) => { const p = join(root, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(data)); };
        w('a/collated_edition/index.json', { juan_files: ['juan/001.json', 'juan/002.json'] });
        w('b/collated_edition/index.json', { juan_files: [] });
        w('c/full_text/index.json', { chapters: [{ file: '001.md' }] });
        w('d/full_text/index.json', { chapters: [] });
        assert.equal(collatedFirstJuan(join(root, 'a')), 'juan/001.json');
        assert.equal(collatedFirstJuan(join(root, 'b')), null); // juan_files 为空
        assert.equal(collatedFirstJuan(join(root, 'none')), null); // 没有文件
        assert.equal(bookFirstChapter(join(root, 'c')), '001.md');
        assert.equal(bookFirstChapter(join(root, 'd')), null); // chapters 为空
        assert.equal(bookFirstChapter(join(root, 'none')), null);
        // Work 全文：Book 所有的、total_chapters 为 0 的、没 key 的都不算；primary 优先
        assert.equal(workFullTextPick(undefined), null);
        assert.equal(workFullTextPick([{ key: 'x', owner_type: 'Book', total_chapters: 3 }]), null);
        assert.equal(workFullTextPick([{ key: 'x', owner_type: 'Work', total_chapters: 0 }]), null);
        assert.equal(workFullTextPick([{ owner_type: 'Work', total_chapters: 3 }]), null);
        assert.equal(workFullTextPick([{ key: 'x', owner_type: 'Work', total_chapters: 3 }, { key: 'y', owner_type: 'Work', total_chapters: 2, primary: true }]).key, 'y');
        assert.equal(workFullTextPick([{ key: 'x', owner_type: 'Work', total_chapters: 3 }]).key, 'x');
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('toReadCard：没有提要，整理本带标记', () => {
    const c = toReadCard({ id: 'w1', title: '易', description: '很长的提要', juan_count: 2, classification: cls('經部', '易類') }, true);
    assert.deepEqual(c, { id: 'w1', title: '易', juan: 2, collated: true, classification: ['經部', '易類'] });
    assert.equal('collated' in toReadCard({ id: 'w2', title: '书' }, false), false);
});

test('toReadCard：带版本名（Book 的 edition），空白版本名不带', () => {
    assert.equal(toReadCard({ id: 'b1', title: '石頭記', edition: ' 甲戌本 ' }, false).edition, '甲戌本');
    assert.equal('edition' in toReadCard({ id: 'b2', title: '石頭記', edition: '  ' }, false), false);
    assert.equal('edition' in toReadCard({ id: 'b3', title: '石頭記' }, false), false);
});

test('compareReadCards：整理本在前，再按书名拼音，再按 id', () => {
    const list = [
        { id: 'c', title: '乙' },
        { id: 'b', title: '甲', collated: true },
        { id: 'a', title: '甲' },
    ].sort(compareReadCards);
    assert.deepEqual(list.map((x) => x.id), ['b', 'a', 'c']);
});

function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'read-idx-'));
    const draft = join(root, 'draft');
    const text = join(root, 'text');
    const out = join(root, 'out');
    const put = (rel, data) => {
        const p = join(draft, rel);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, JSON.stringify(data));
    };
    const works = {};
    const add = (id, extra, flags, detail = {}) => {
        const path = `Work/${id}.json`;
        put(path, { id, title: `書${id}`, ...extra, ...detail });
        works[id] = { id, path, _root: 'draft', ...flags };
    };
    const putText = (rel, data) => {
        const p = join(text, rel);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, JSON.stringify(data));
    };
    const ftList = {}; // book-text/index/full_text 的 { workId: entry[] }
    const fullText = (id, extra = {}) => { ftList[id] = [{ key: 'k1', owner_type: 'Work', primary: true, total_chapters: 3, ...extra }]; };
    const collated = (id) => putText(`Work/${id}/collated_edition/index.json`, { juan_files: ['juan/001.json'] });
    add('wc', { classification: cls('史部', '正史類') }, { has_collated: true, has_text: true });
    collated('wc'); fullText('wc');
    add('wt', { classification: cls('史部', '正史類') }, { has_text: true });
    fullText('wt');
    add('wn', { classification: cls('史部', '正史類') }, { has_text: true }); // 只有外部资源标记、站内无正文：不可读（overview#306）
    add('wu', {}, {}); // 未分類
    fullText('wu');
    add('wm', { classification: cls('經部'), merged_into: 'wc' }, {}); // 被并
    fullText('wm');
    add('wd', { classification: cls('經部') }, {});
    fullText('wd');
    add('wz', { classification: cls('經部') }, { has_text: true }); // 全文目录 total_chapters=0：不可读
    fullText('wz', { total_chapters: 0 });
    add('wb', { classification: cls('經部') }, { has_text: true }); // 全文清单属于 Book：不可读
    fullText('wb', { owner_type: 'Book' });
    for (let i = 0; i < 25; i++) {
        const id = `p${String(i).padStart(2, '0')}`;
        add(id, { classification: cls('子部', '儒家類') }, { has_text: true });
        fullText(id);
    }
    putText('index/full_text/0.json', ftList);
    const books = {};
    const addBook = (id, flags, chapters) => {
        const path = `Book/${id}.json`;
        put(path, { id, title: `本${id}` });
        books[id] = { id, path, _root: 'draft', ...flags };
        if (chapters) putText(`Book/${id}/full_text/index.json`, { chapters });
    };
    addBook('bt', { has_text: true }); // 只有外部资源标记：不可读
    addBook('bf', {}, [{ file: '001.md' }]);
    addBook('be', {}, []); // 目录空：不可读
    addBook('bn', {});
    mkdirSync(out, { recursive: true });
    return { root, out, index: { works, books }, rootDirFor: () => draft, textDirFor: () => text };
}

test('bundleRead：只收可读 Work，节点 id 与总目一致，未分類在最后，精选清单与分页写盘', () => {
    const f = fixture();
    try {
        const r = bundleRead({ ...f, dataDir: f.out, log: () => {} });
        const tree = JSON.parse(readFileSync(join(f.out, 'read/tree.json'), 'utf-8'));
        assert.deepEqual(tree.map((n) => n.label), ['經部', '史部', '子部', '未分類']);
        const shi = tree.find((n) => n.label === '史部');
        assert.equal(shi.id, nodeIdFor(['史部']));
        assert.equal(shi.count, 2); // wc、wt；wn 站内无正文不可读
        assert.equal(shi.children[0].id, nodeIdFor(['史部', '正史類']));
        assert.equal(tree.at(-1).id, UNCLASSIFIED_ID);
        assert.equal(tree.find((n) => n.label === '經部').count, 1); // 只有 wd：被并的 wm、目录空的 wz、Book 所有的 wb 都不算

        // 有整理本在前
        const p1 = JSON.parse(readFileSync(join(f.out, `read/${shi.id}/1.json`), 'utf-8'));
        assert.deepEqual(p1.map((c) => c.id), ['wc', 'wt']);
        assert.equal(p1[0].collated, true);

        // 25 部子部 → 2 页（每页 READ_PAGE_SIZE）
        const zi = tree.find((n) => n.label === '子部');
        assert.equal(zi.count, 25);
        assert.equal(JSON.parse(readFileSync(join(f.out, `read/${zi.id}/1.json`), 'utf-8')).length, READ_PAGE_SIZE);
        assert.equal(JSON.parse(readFileSync(join(f.out, `read/${zi.id}/2.json`), 'utf-8')).length, 25 - READ_PAGE_SIZE);
        assert.equal(existsSync(join(f.out, `read/${zi.id}/3.json`)), false);

        const feat = JSON.parse(readFileSync(join(f.out, 'read/featured.json'), 'utf-8'));
        assert.deepEqual(feat.collated.map((c) => c.id), ['wc']);
        assert.deepEqual(feat.books.map((c) => c.id), ['bf']); // bt 只有外部资源标记、be 目录空、bn 没全文
    } finally {
        rmSync(f.root, { recursive: true, force: true });
    }
});

test('bundleRead：重跑不留旧文件（作品不再可读后其页文件被删）', () => {
    const f = fixture();
    try {
        bundleRead({ ...f, dataDir: f.out, log: () => {} });
        assert.equal(existsSync(join(f.out, 'read/featured.json')), true);
        // 去掉全部 p* 作品
        for (const id of Object.keys(f.index.works)) if (id.startsWith('p')) delete f.index.works[id];
        const r = bundleRead({ ...f, dataDir: f.out, log: () => {} });
        assert.ok(r.written.removed >= 2);
        const tree = JSON.parse(readFileSync(join(f.out, 'read/tree.json'), 'utf-8'));
        assert.equal(tree.find((n) => n.label === '子部'), undefined);
    } finally {
        rmSync(f.root, { recursive: true, force: true });
    }
});

test('verifyReadProbes：新结构整理本首章只有 json（has_json，没有 md）不算缺；没有 has_json 时 md 必须在', () => {
    const root = mkdtempSync(join(tmpdir(), 'read-verify-new-'));
    try {
        const put = (rel, data) => { const p = join(root, 'items', rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, data); };
        put('w1/manifest.json', '{}');
        put('w1/default/index.json', '{}');
        put('w1/default/001.json', '{}');
        assert.deepEqual(verifyReadProbes([
            { id: 'w1', kind: 'manifest' },
            { id: 'w1', kind: 'text', key: 'default', first: { file: '001', hasJson: true } },
        ], root), []);
        const bad = verifyReadProbes([{ id: 'w1', kind: 'text', key: 'default', first: { file: '001', hasJson: false } }], root);
        assert.equal(bad.length, 1);
        assert.match(bad[0], /default\/001\.txt/);
        // has_json 但 json 也没有：照样报缺
        assert.match(verifyReadProbes([{ id: 'w1', kind: 'text', key: 'default', first: { file: '002', hasJson: true } }], root)[0], /default\/002\.json/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('verifyReadProbes：产物里目录或首章／首卷缺了就列出来（.md 按 .txt 找）', () => {
    const root = mkdtempSync(join(tmpdir(), 'read-verify-'));
    try {
        const put = (rel, data) => { const p = join(root, 'items', rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, data); };
        put('w1/full_text/k1/index.json', JSON.stringify({ chapters: [{ file: '001.md' }] }));
        put('w1/full_text/k1/001.txt', '正文');
        put('w1/collated_edition/index.json', '{}');
        put('w1/collated_edition/juan/001.json', '{}');
        put('b1/full_text/index.json', '{}');
        put('b1/full_text/001.txt', '正文');
        const ok = [
            { id: 'w1', kind: 'fulltext', key: 'k1' },
            { id: 'w1', kind: 'collated', first: 'juan/001.json' },
            { id: 'b1', kind: 'book', first: '001.md' },
        ];
        assert.deepEqual(verifyReadProbes(ok, root), []);
        const bad = verifyReadProbes([
            { id: 'w2', kind: 'fulltext', key: 'k1' },
            { id: 'w1', kind: 'collated', first: 'juan/009.json' },
            { id: 'b1', kind: 'book', first: '009.md' },
        ], root);
        assert.equal(bad.length, 3);
        assert.match(bad[0], /w2: items\/w2\/full_text\/k1\/index\.json/);
        assert.match(bad[1], /collated_edition\/juan\/009\.json/);
        assert.match(bad[2], /full_text\/009\.txt/);
        // 全文目录 chapters 为空也算缺
        put('w3/full_text/k1/index.json', JSON.stringify({ chapters: [] }));
        assert.match(verifyReadProbes([{ id: 'w3', kind: 'fulltext', key: 'k1' }], root)[0], /chapters 为空/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('bundleRead verifyItems：产物里缺数据文件则构建失败，全在则通过', () => {
    const f = fixture();
    try {
        // 产物里什么都没有 → 抛错并列出缺失
        assert.throws(() => bundleRead({ ...f, dataDir: f.out, verifyItems: true, log: () => {} }), /阅读卡片对应的数据文件在产物里缺失/);
        // 把文本仓的 items 按 bundle-data 的做法复制进产物（.md → .txt）
        const text = f.textDirFor();
        const put = (rel, data) => { const p = join(f.out, 'items', rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, data); };
        for (const id of ['wc', 'wt', 'wu', 'wd', ...Array.from({ length: 25 }, (_, i) => `p${String(i).padStart(2, '0')}`)]) {
            put(`${id}/full_text/k1/index.json`, JSON.stringify({ chapters: [{ file: '001.md' }] }));
            put(`${id}/full_text/k1/001.txt`, '正文');
        }
        put('wc/collated_edition/index.json', '{}');
        put('wc/collated_edition/juan/001.json', '{}');
        put('bf/full_text/index.json', '{}');
        put('bf/full_text/001.txt', '正文');
        assert.ok(existsSync(text));
        const r = bundleRead({ ...f, dataDir: f.out, verifyItems: true, log: () => {} });
        assert.equal(r.books.length, 1);
    } finally {
        rmSync(f.root, { recursive: true, force: true });
    }
});
