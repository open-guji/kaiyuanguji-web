/**
 * mentions.test.mjs — 专名出处反查（A12）：逐章收集、分桶汇总分页、id 归一、删旧页、计数守恒。
 * 用法：node --test scripts/lib/mentions.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chapterMentions, createMentionCollector, makeIdResolver, pagePath, PAGE_SIZE } from './mentions.mjs';

const cells = (page, col, s) => [...s].map((c, i) => ({ a: `${page}:${col}:${i + 1}`, c }));
const CHAR = {
    pages: [
        { page: 3, columns: [{ col: 1, cells: cells(3, 1, '欽定四庫全書總目卷首一') }, { col: 2, cells: cells(3, 2, '周程張朱諸儒泰州如臯人') }] },
        // 夹注双行：a／b 子列
        { page: 4, columns: [{ col: 1, cells: [{ a: '4:1:1a', c: '朱' }, { a: '4:1:1b', c: '子' }] }] },
    ],
};
const ENTITY = {
    version: '1.2.0',
    entities: [
        { id: 'e1', type: 'people', text: '朱', anchor: { start: '3:2:4', end: '3:2:4' }, target: { status: 'matched', entity_id: 'zhuxi' } },
        { id: 'e2', type: 'people', text: '朱子', anchor: { start: '4:1:1a', end: '4:1:1b' }, target: { status: 'matched', entity_id: 'zhuxi' } },
        { id: 'e3', type: 'people', text: '程', anchor: { start: '3:2:2', end: '3:2:2' }, target: { status: 'ambiguous', candidates: ['a', 'b'] } },
        {
            id: 'e4', type: 'place', text: '泰州如臯', anchor: { start: '3:2:7', end: '3:2:10' }, target: { status: 'new_candidate', canonical_name: '泰州如臯' },
            decomposition: { mode: 'split', parts: [
                { text: '泰州', offset: [0, 2], target: { status: 'matched', entity_id: 'taizhou' } },
                { text: '如臯', offset: [2, 4], target: { status: 'new_candidate' } },
            ] },
        },
    ],
};
const HEADINGS = [{ label: '卷首一', anchor: '3:1:1' }, { label: '聖諭', anchor: '3:2:1' }];

test('chapterMentions：只收 matched 与拆分片段；带上下文、章内标题、版本', () => {
    const list = chapterMentions({ item: 'bk', key: 'default', chapter: '001', entity: ENTITY, char: CHAR, headings: HEADINGS });
    assert.deepEqual(list.map((m) => [m.eid, m.rec.start, m.rec.end]), [
        ['zhuxi', '3:2:4', '3:2:4'],
        ['zhuxi', '4:1:1a', '4:1:1b'],
        ['taizhou', '3:2:7', '3:2:8'],
    ]);
    const first = list[0].rec;
    assert.equal(first.heading, '聖諭');
    assert.equal(first.before, '四庫全書總目卷首一周程張'.slice(-12));
    assert.equal(first.after, '諸儒泰州如臯人朱子');
    assert.equal(first.v, '1.2.0');
});

test('收集→汇总：分页、第 1 页带 total／books、计数守恒、归一与删旧页', () => {
    const root = mkdtempSync(join(tmpdir(), 'mentions-'));
    const out = join(root, 'out');
    // 上次留下的旧页：不再产出的要删掉
    mkdirSync(join(out, 'mentions', 'gone'), { recursive: true });
    writeFileSync(join(out, 'mentions', 'gone.json'), '{}');
    writeFileSync(join(out, 'mentions', 'gone', '2.json'), '{}');

    const col = createMentionCollector({ spoolDir: join(root, 'spool') });
    // 一章重复多次，凑出超过一页
    const n = Math.ceil((PAGE_SIZE + 5) / 2);
    for (let i = 0; i < n; i++) col.add({ item: 'bk', key: 'default', chapter: String(i + 1).padStart(3, '0'), entity: ENTITY, char: CHAR, headings: HEADINGS });
    // taizhou 是墓碑，并入 taizhou2；草稿 id 经 promotions 升格
    const entries = { zhuxi: {}, taizhou: { merged_into: 'taizhou2' }, taizhou2: {}, bk: { title: '某書' } };
    const r = col.finalize({
        outDir: out,
        resolveId: makeIdResolver({ promotions: {}, readEntry: (id) => entries[id] ?? null }),
        titleOf: (id) => entries[id]?.title,
    });
    assert.equal(r.chapters, n);
    assert.equal(r.mentions, n * 3);
    assert.equal(r.unresolved, 0);
    assert.equal(r.entities, 2);
    const p1 = JSON.parse(readFileSync(join(out, 'mentions', pagePath('zhuxi', 1)), 'utf-8'));
    assert.equal(p1.total, n * 2);
    assert.equal(p1.pages, 2);
    assert.deepEqual(p1.books, [{ item: 'bk', title: '某書', count: n * 2 }]);
    assert.equal(p1.items.length, PAGE_SIZE);
    // 顺序：章序，章内字序
    assert.deepEqual(p1.items.slice(0, 2).map((x) => [x.chapter, x.start]), [['001', '3:2:4'], ['001', '4:1:1a']]);
    const p2 = JSON.parse(readFileSync(join(out, 'mentions', pagePath('zhuxi', 2)), 'utf-8'));
    assert.equal(p2.items.length, n * 2 - PAGE_SIZE);
    assert.equal(p2.books, undefined);
    assert.ok(existsSync(join(out, 'mentions', 'taizhou2.json')));
    assert.ok(!existsSync(join(out, 'mentions', 'taizhou.json')));
    assert.ok(!existsSync(join(out, 'mentions', 'gone.json')));
    assert.ok(!existsSync(join(out, 'mentions', 'gone')));
    assert.ok(!existsSync(join(root, 'spool')));
});

test('makeIdResolver：升格、墓碑链、正式库没有的回 null、成环回 null', () => {
    const entries = { a: { merged_into: 'b' }, b: { merged_into: 'c' }, c: {}, x: { merged_into: 'y' }, y: { merged_into: 'x' }, prod: {} };
    const resolve = makeIdResolver({ promotions: { draft1: { production_id: 'prod' } }, readEntry: (id) => entries[id] ?? null });
    assert.equal(resolve('a'), 'c');
    assert.equal(resolve('draft1'), 'prod');
    assert.equal(resolve('nope'), null);
    assert.equal(resolve('x'), null);
});
