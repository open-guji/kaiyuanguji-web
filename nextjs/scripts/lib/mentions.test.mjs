/**
 * mentions.test.mjs — 专名出处反查（A12）：逐章聚合、分桶汇总成书／章目录、id 归一、删旧文件、计数守恒。
 * 用法：node --test scripts/lib/mentions.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chapterMentions, createMentionCollector, makeIdResolver, CHAPTER_INLINE, EXAMPLES, MENTIONS_SCHEMA } from './mentions.mjs';

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

test('chapterMentions：合称各条目各算一次', () => {
    const entity = { entities: [{ id: 'm', type: 'people', text: '周程', anchor: { start: '3:2:1', end: '3:2:2' }, target: { status: 'matched_multi', targets: [{ entity_id: 'zhou' }, { entity_id: 'cheng' }, { entity_id: 'cheng' }] } }] };
    const list = chapterMentions({ item: 'bk', key: 'default', chapter: '001', entity, char: CHAR, headings: [] });
    assert.deepEqual(list.map((m) => [m.eid, m.rec.start, m.rec.end]), [['zhou', '3:2:1', '3:2:2'], ['cheng', '3:2:1', '3:2:2']]);
});

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

test('收集→汇总：书／章目录、例子、计数守恒、归一（记原始 id）、删旧文件', () => {
    const root = mkdtempSync(join(tmpdir(), 'mentions-'));
    const out = join(root, 'out');
    // 上次留下的旧文件：不再产出的要删掉
    mkdirSync(join(out, 'mentions', 'gone'), { recursive: true });
    writeFileSync(join(out, 'mentions', 'gone.json'), '{}');
    writeFileSync(join(out, 'mentions', 'gone', 'bk.json'), '{}');

    const col = createMentionCollector({ spoolDir: join(root, 'spool') });
    const n = 15;
    for (let i = 0; i < n; i++) col.add({ item: 'bk', key: 'default', chapter: String(i + 1).padStart(3, '0'), entity: ENTITY, char: CHAR, headings: HEADINGS });
    // taizhou 是墓碑，并入 taizhou2；草稿 id 经 promotions 升格
    const entries = { zhuxi: {}, taizhou: { merged_into: 'taizhou2' }, taizhou2: {}, bk: { title: '某書' } };
    const r = col.finalize({
        outDir: out,
        resolveId: makeIdResolver({ promotions: {}, readEntry: (id) => entries[id] ?? null }),
        titleOf: (id) => entries[id]?.title,
    });
    assert.equal(r.schema, MENTIONS_SCHEMA);
    assert.equal(r.chapters, n);
    assert.equal(r.mentions, n * 3);
    assert.equal(r.rows, n * 2);
    assert.equal(r.unresolved, 0);
    assert.equal(r.entities, 2);
    assert.equal(r.files, 2);
    const z = JSON.parse(readFileSync(join(out, 'mentions', 'zhuxi.json'), 'utf-8'));
    assert.equal(z.total, n * 2);
    assert.equal(z.chapters, n);
    assert.equal(z.books.length, 1);
    assert.deepEqual({ ...z.books[0], chapters: undefined }, { item: 'bk', title: '某書', count: n * 2, chapter_count: n, chapters: undefined });
    assert.deepEqual(z.books[0].chapters[0], { key: 'default', chapter: '001', count: 2, heading: '聖諭' });
    // 例子：先每章第 1 条（15 条），再补第 2 条到 20
    assert.equal(z.examples.length, EXAMPLES);
    assert.deepEqual(z.examples.slice(0, 2).map((x) => [x.chapter, x.start]), [['001', '3:2:4'], ['002', '3:2:4']]);
    assert.deepEqual([z.examples[n].chapter, z.examples[n].start], ['001', '4:1:1a']);
    // 墓碑归一：章行记下原始 id，阅读页用它在 entity 文件里找
    const t = JSON.parse(readFileSync(join(out, 'mentions', 'taizhou2.json'), 'utf-8'));
    assert.deepEqual(t.books[0].chapters[0].ids, ['taizhou']);
    assert.ok(!existsSync(join(out, 'mentions', 'taizhou.json')));
    assert.ok(!existsSync(join(out, 'mentions', 'gone.json')));
    assert.ok(!existsSync(join(out, 'mentions', 'gone')));
    assert.ok(!existsSync(join(root, 'spool')));
});

test('原始 id 与现行 id 落在不同桶：仍只出一份、计数合在一起', () => {
    const root = mkdtempSync(join(tmpdir(), 'mentions-'));
    const out = join(root, 'out');
    const col = createMentionCollector({ spoolDir: join(root, 'spool') });
    // 造 40 个墓碑 id 都并入 zhuxi：总有落在别的桶里的
    const ids = Array.from({ length: 40 }, (_, i) => `old${i}`);
    for (const [i, id] of ids.entries()) {
        const entity = { entities: [{ id: 'x', type: 'people', text: '朱', anchor: { start: '3:2:4', end: '3:2:4' }, target: { status: 'matched', entity_id: id } }] };
        col.add({ item: 'bk', key: 'default', chapter: String(i).padStart(3, '0'), entity, char: CHAR, headings: [] });
    }
    const r = col.finalize({ outDir: out, resolveId: (id) => (id.startsWith('old') ? 'zhuxi' : id) });
    assert.equal(r.entities, 1);
    assert.equal(r.files, 1);
    const z = JSON.parse(readFileSync(join(out, 'mentions', 'zhuxi.json'), 'utf-8'));
    assert.equal(z.total, 40);
    assert.equal(z.books[0].chapters.length, 40);
    assert.deepEqual(z.books[0].chapters[0].ids, ['old0']);
});

test('章行超过 CHAPTER_INLINE：各书章目录拆到 <id>/<item>.json，主文件只留书的计数', () => {
    const root = mkdtempSync(join(tmpdir(), 'mentions-'));
    const out = join(root, 'out');
    const col = createMentionCollector({ spoolDir: join(root, 'spool') });
    const m = CHAPTER_INLINE + 1;
    for (let i = 0; i < m; i++) col.add({ item: i % 2 ? 'b2' : 'b1', key: 'default', chapter: String(i).padStart(4, '0'), entity: ENTITY, char: CHAR, headings: HEADINGS });
    const r = col.finalize({ outDir: out });
    assert.equal(r.split_entities, 2); // zhuxi 与 taizhou 各 m 章
    const z = JSON.parse(readFileSync(join(out, 'mentions', 'zhuxi.json'), 'utf-8'));
    assert.equal(z.chapters, m);
    assert.deepEqual(z.books.map((b) => [b.item, b.chapter_count, b.chapters]), [['b1', Math.ceil(m / 2), undefined], ['b2', Math.floor(m / 2), undefined]]);
    const b1 = JSON.parse(readFileSync(join(out, 'mentions', 'zhuxi', 'b1.json'), 'utf-8'));
    assert.equal(b1.chapters.length, Math.ceil(m / 2));
    // 再打一次、不再拆分：拆出来的目录要删掉
    const col2 = createMentionCollector({ spoolDir: join(root, 'spool') });
    col2.add({ item: 'b1', key: 'default', chapter: '001', entity: ENTITY, char: CHAR, headings: HEADINGS });
    const r2 = col2.finalize({ outDir: out });
    assert.ok(!existsSync(join(out, 'mentions', 'zhuxi')));
    assert.ok(r2.removed >= 2);
});

test('makeIdResolver：升格、墓碑链、正式库没有的回 null、成环回 null', () => {
    const entries = { a: { merged_into: 'b' }, b: { merged_into: 'c' }, c: {}, x: { merged_into: 'y' }, y: { merged_into: 'x' }, prod: {} };
    const resolve = makeIdResolver({ promotions: { draft1: { production_id: 'prod' } }, readEntry: (id) => entries[id] ?? null });
    assert.equal(resolve('a'), 'c');
    assert.equal(resolve('draft1'), 'prod');
    assert.equal(resolve('nope'), null);
    assert.equal(resolve('x'), null);
});
