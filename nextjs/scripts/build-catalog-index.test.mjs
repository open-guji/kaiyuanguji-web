#!/usr/bin/env node
/**
 * build-catalog-index.test.mjs — 古籍总目构建期索引（N4b）的脚本单测
 * （不进 jest，同 bundle-data-work-fulltext.test.mjs 一类脚本测试）。
 *
 * 覆盖：分类路径解析、卡片字段（契约 overview#218 第 4 条）、排序（有提要优先再按书名）、
 * 分类树计数与次序（经史子集、分类表次序、未分類最后）、分页写盘与清旧文件、
 * bundleCatalog 跳过被并条目，以及 bundle-data.mjs 整条流程产出 catalog/。
 *
 * 用法：node --test scripts/build-catalog-index.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
    CATALOG_PAGE_SIZE,
    UNCLASSIFIED_ID,
    SUMMARY_MAX,
    bundleCatalog,
    buildCatalog,
    classificationPath,
    compareCards,
    nodeIdFor,
    taxonomyRank,
    toCard,
    writeCatalog,
} from './build-catalog-index.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const cls = (l1, l2 = '', l3 = '', l4 = '') => ({ l1, l2, l3, l4, basis: 'S', source: '千頃堂書目' });

test('classificationPath：取 l1 起连续非空的几级', () => {
    assert.deepEqual(classificationPath(cls('史部', '正史類')), ['史部', '正史類']);
    assert.deepEqual(classificationPath(cls('子部', '', '雜家之屬')), ['子部']);
    assert.deepEqual(classificationPath(cls('')), []);
    assert.deepEqual(classificationPath(undefined), []);
    assert.deepEqual(classificationPath({ l1: ' 集部 ', l2: '別集類' }), ['集部', '別集類']);
});

test('nodeIdFor：稳定、URL 安全、按路径区分', () => {
    const a = nodeIdFor(['史部', '正史類']);
    assert.match(a, /^c[0-9a-f]{10}$/);
    assert.equal(a, nodeIdFor(['史部', '正史類']));
    assert.notEqual(a, nodeIdFor(['史部']));
});

test('toCard：契约字段，提要截断，第一作者借作品朝代', () => {
    const long = '甲'.repeat(SUMMARY_MAX + 10);
    const c = toCard({
        id: 'w1', title: '史記', juan_count: 130, dynasty: '西漢',
        authors: [{ name: '司馬遷', role: '撰', entity_id: 'x' }, { name: '裴駰', role: '集解' }],
        description: { text: long, sources: [] },
        classification: cls('史部', '正史類'),
        indexed_by: [{ source: 'x' }],
    });
    assert.deepEqual(Object.keys(c).sort(), ['authors', 'classification', 'id', 'juan', 'summary', 'title']);
    assert.equal(c.juan, 130);
    assert.deepEqual(c.authors, [{ name: '司馬遷', dynasty: '西漢' }, { name: '裴駰' }]);
    assert.equal(Array.from(c.summary).length, SUMMARY_MAX + 1);
    assert.ok(c.summary.endsWith('…'));
    assert.deepEqual(c.classification, ['史部', '正史類']);

    const bare = toCard({ id: 'w2', title: '某書', authors: [{ name: '' }], description: { text: '  ' } });
    assert.deepEqual(bare, { id: 'w2', title: '某書' });
});

test('compareCards：有提要优先，再按书名，再按 id', () => {
    const cards = [
        { id: '3', title: '乙' },
        { id: '2', title: '甲', summary: 's' },
        { id: '1', title: '乙', summary: 's' },
        { id: '0', title: '乙' },
    ];
    assert.deepEqual(cards.sort(compareCards).map((c) => c.id), ['2', '1', '0', '3']);
});

test('buildCatalog：计数含子孙，经史子集顺序，分类表次序，未分類最后', () => {
    const works = [
        { id: 'a', title: '甲', classification: cls('集部', '別集類') },
        { id: 'b', title: '乙', classification: cls('史部', '正史類') },
        { id: 'c', title: '丙', classification: cls('史部', '地理類') },
        { id: 'd', title: '丁', classification: cls('史部') },
        { id: 'e', title: '戊', classification: cls('史部', '地理類', '都會郡縣之屬') },
        { id: 'f', title: '己' },
        { id: 'g', title: '庚', classification: cls('經部', '易類') },
    ];
    const rank = taxonomyRank([
        { cata_l1: '史部', cata_l2: '正史類' },
        { cata_l1: '史部', cata_l2: '地理類', cata_l3: '都會郡縣之屬' },
    ]);
    const { tree, lists, stats } = buildCatalog(works, { rank });
    assert.deepEqual(tree.map((n) => n.label), ['經部', '史部', '集部', '未分類']);
    const shi = tree[1];
    assert.equal(shi.count, 4);
    assert.deepEqual(shi.children.map((n) => [n.label, n.count]), [['正史類', 1], ['地理類', 2]]);
    assert.deepEqual(shi.children[1].children.map((n) => [n.label, n.count]), [['都會郡縣之屬', 1]]);
    assert.equal(shi.children[1].children[0].children, undefined);
    assert.equal(tree[3].id, UNCLASSIFIED_ID);
    assert.equal(tree[3].count, 1);
    assert.deepEqual(lists.get(shi.id).map((c) => c.id).sort(), ['b', 'c', 'd', 'e']);
    assert.deepEqual(stats, { total: 7, classified: 6, unclassified: 1, byTop: { 集部: 1, 史部: 4, 經部: 1 } });
    // 树上每个节点都有清单
    const ids = [];
    const walk = (ns) => ns.forEach((n) => { ids.push(n.id); if (n.children) walk(n.children); });
    walk(tree);
    assert.deepEqual(ids.sort(), [...lists.keys()].sort());
});

test('writeCatalog：每页 20 条，内容不变不改写，旧文件清掉', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cat-'));
    try {
        const works = Array.from({ length: 45 }, (_, i) => ({
            id: `w${String(i).padStart(2, '0')}`, title: `書${i}`, classification: cls('經部', '易類'),
        }));
        const built = buildCatalog(works);
        const w = writeCatalog(dir, built);
        const jing = built.tree[0];
        assert.equal(jing.count, 45);
        // tree + 經部 3 页 + 易類 3 页
        assert.equal(w.files, 7);
        const p1 = JSON.parse(readFileSync(join(dir, 'catalog', jing.id, '1.json'), 'utf-8'));
        const p3 = JSON.parse(readFileSync(join(dir, 'catalog', jing.id, '3.json'), 'utf-8'));
        assert.equal(p1.length, CATALOG_PAGE_SIZE);
        assert.equal(p3.length, 5);
        assert.ok(!existsSync(join(dir, 'catalog', jing.id, '4.json')));
        assert.deepEqual(JSON.parse(readFileSync(join(dir, 'catalog', 'tree.json'), 'utf-8')), built.tree);

        // 第二版：少了一半，且没有易類（改成史部）
        const next = buildCatalog(works.slice(0, 10).map((x) => ({ ...x, classification: cls('史部') })));
        const w2 = writeCatalog(dir, next);
        assert.equal(w2.files, 2);
        assert.equal(w2.removed, 6);
        assert.ok(!existsSync(join(dir, 'catalog', jing.id)));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('bundleCatalog：读详情，跳过被并条目与缺文件', () => {
    const base = mkdtempSync(join(tmpdir(), 'cat-'));
    try {
        const root = join(base, 'prod');
        const put = (rel, obj) => {
            mkdirSync(dirname(join(root, rel)), { recursive: true });
            writeFileSync(join(root, rel), JSON.stringify(obj));
        };
        put('Work/a.json', { id: 'a', title: '甲', classification: cls('子部', '雜家類') });
        put('Work/b.json', { id: 'b', title: '乙', merged_into: 'a' });
        put('Work/c.json', { id: 'c', title: '丙' });
        const index = {
            works: {
                a: { id: 'a', path: 'Work/a.json', _root: 'official' },
                b: { id: 'b', path: 'Work/b.json', _root: 'official' },
                c: { id: 'c', path: 'Work/c.json', _root: 'official' },
                z: { id: 'z', path: 'Work/z.json', _root: 'official' },
            },
        };
        const out = bundleCatalog({ index, rootDirFor: () => root, dataDir: join(base, 'data'), log: () => {} });
        assert.equal(out.merged, 1);
        assert.deepEqual(out.perRoot, { official: { classified: 1, unclassified: 1 } });
        assert.deepEqual(out.tree.map((n) => [n.label, n.count]), [['子部', 1], ['未分類', 1]]);
        assert.ok(existsSync(join(base, 'data', 'catalog', UNCLASSIFIED_ID, '1.json')));
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});

test('bundle-data.mjs 整条流程产出 catalog/', () => {
    const base = mkdtempSync(join(tmpdir(), 'cat-bd-'));
    try {
        const draft = join(base, 'draft');
        const workRel = 'Work/a/a/a/aaaaaaaaaaa-史記.json';
        mkdirSync(join(draft, 'index', 'works'), { recursive: true });
        mkdirSync(join(draft, dirname(workRel)), { recursive: true });
        writeFileSync(join(draft, 'index', 'works', '0.json'),
            JSON.stringify({ aaaaaaaaaaa: { id: 'aaaaaaaaaaa', title: '史記', type: 'work', path: workRel } }));
        writeFileSync(join(draft, workRel), JSON.stringify({
            id: 'aaaaaaaaaaa', title: '史記', type: 'work', classification: cls('史部', '正史類'),
        }));
        execFileSync('git', ['init', '-q'], { cwd: draft });
        const dataRoot = join(base, 'out');
        execFileSync(process.execPath, [join(__dirname, 'bundle-data.mjs')], {
            cwd: join(__dirname, '..'),
            env: {
                ...process.env,
                KYG_DATA_ROOT: dataRoot,
                BOOK_INDEX_DRAFT_DIR: draft,
                BOOK_INDEX_PRODUCTION_DIR: join(base, 'none'),
                BOOK_TEXT_DIR: join(base, 'none-text'),
            },
            stdio: 'pipe',
        });
        const tree = JSON.parse(readFileSync(join(dataRoot, 'data', 'catalog', 'tree.json'), 'utf-8'));
        assert.deepEqual(tree, [{
            id: nodeIdFor(['史部']), label: '史部', count: 1,
            children: [{ id: nodeIdFor(['史部', '正史類']), label: '正史類', count: 1 }],
        }]);
        const page = JSON.parse(readFileSync(join(dataRoot, 'data', 'catalog', nodeIdFor(['史部', '正史類']), '1.json'), 'utf-8'));
        assert.deepEqual(page, [{ id: 'aaaaaaaaaaa', title: '史記', classification: ['史部', '正史類'] }]);
    } finally {
        rmSync(base, { recursive: true, force: true });
    }
});
