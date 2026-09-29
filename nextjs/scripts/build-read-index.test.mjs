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
import { READ_PAGE_SIZE, bundleRead, compareReadCards, toReadCard, workCollated, workReadable } from './build-read-index.mjs';

const cls = (l1, l2 = '') => ({ l1, l2, l3: '', l4: '', basis: 'S', source: 'x' });

test('workReadable / workCollated：索引项或详情标记为 true 才算', () => {
    assert.equal(workReadable({}, {}), false);
    assert.equal(workReadable({ has_text: true }, {}), true);
    assert.equal(workReadable({}, { _has_collated: true }), true);
    assert.equal(workReadable({ has_image: true }, { has_text: false }), false);
    assert.equal(workCollated({ has_collated: true }, {}), true);
    assert.equal(workCollated({ has_text: true }, {}), false);
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
    add('wc', { classification: cls('史部', '正史類') }, { has_collated: true, has_text: true });
    add('wt', { classification: cls('史部', '正史類') }, { has_text: true });
    add('wn', { classification: cls('史部', '正史類') }, {}); // 不可读
    add('wu', {}, { has_text: true }); // 未分類
    add('wm', { classification: cls('經部'), merged_into: 'wc' }, { has_text: true }); // 被并
    add('wd', { classification: cls('經部') }, {}, { _has_text: true }); // 详情标记
    for (let i = 0; i < 25; i++) add(`p${String(i).padStart(2, '0')}`, { classification: cls('子部', '儒家類') }, { has_text: true });
    const books = {};
    const addBook = (id, flags, ft) => {
        const path = `Book/${id}.json`;
        put(path, { id, title: `本${id}` });
        books[id] = { id, path, _root: 'draft', ...flags };
        if (ft) {
            const p = join(text, dirname(path), id, 'full_text', 'index.json');
            mkdirSync(dirname(p), { recursive: true });
            writeFileSync(p, '{}');
        }
    };
    addBook('bt', { has_text: true });
    addBook('bf', {}, true);
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
        assert.equal(shi.count, 2); // wc、wt；wn 不可读
        assert.equal(shi.children[0].id, nodeIdFor(['史部', '正史類']));
        assert.equal(tree.at(-1).id, UNCLASSIFIED_ID);
        assert.equal(tree.find((n) => n.label === '經部').count, 1); // 只有 wd，被并的 wm 跳过

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
        assert.deepEqual(feat.books.map((c) => c.id).sort(), ['bf', 'bt']); // bn 没全文
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
