#!/usr/bin/env node
/**
 * build-read-index.test.mjs — 阅读首页可读条目索引的脚本单测（overview#267 第 16 项、#308；
 * 不进 jest，同 build-catalog-index.test.mjs）。
 *
 * 覆盖：可读判定（只认新结构 manifest）、卡片字段（period／subtype／text_count／work_id）、朝代归段、
 * 排序、与总目同一套节点 id、未分類、被并条目跳过、首页分区 sections.json（策展文件有／无／坏）、
 * 年代分页、写盘结构与清旧文件、产物核对。
 *
 * 用法：node --test scripts/build-read-index.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { nodeIdFor, UNCLASSIFIED_ID } from './build-catalog-index.mjs';
import {
    READ_PAGE_SIZE, READ_PERIODS, buildSections, bundleRead, compareReadCards, comparePeriodCards, periodOf, readCuration,
    toReadCard, verifyReadProbes,
} from './build-read-index.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLE = join(here, 'fixtures', 'read-home.sample.json');
const cls = (l1, l2 = '') => ({ l1, l2, l3: '', l4: '', basis: 'S', source: 'x' });
/** 条目里的分类字段：build 产物的 `_classifications[]` 单项（旧 `classification` 回退已删，overview#522） */
const clsN = (l1, l2 = '') => ({ scheme: 'zongmu', ...cls(l1, l2) });
const json = (p) => JSON.parse(readFileSync(p, 'utf-8'));

test('periodOf：朝代名归 9 段，前缀、简体、后缀都认；外国与空返回 null', () => {
    assert.equal(periodOf('戰國'), 'xianqin');
    assert.equal(periodOf('東漢'), 'qinhan');
    assert.equal(periodOf('东汉'), 'qinhan');
    assert.equal(periodOf('南朝梁'), 'weijin');
    assert.equal(periodOf('三國魏'), 'weijin');
    assert.equal(periodOf('劉宋'), 'weijin');
    assert.equal(periodOf('五代'), 'suitang');
    assert.equal(periodOf('南唐'), 'suitang');
    assert.equal(periodOf('北宋'), 'song');
    assert.equal(periodOf('宋末元初'), 'song');
    assert.equal(periodOf('金'), 'liaojinyuan');
    assert.equal(periodOf('明末清初'), 'ming');
    assert.equal(periodOf('清代'), 'qing');
    assert.equal(periodOf('唐朝'), 'suitang');
    assert.equal(periodOf('〔清〕'), 'qing');
    assert.equal(periodOf('民國'), 'modern');
    assert.equal(periodOf('日本'), null);
    assert.equal(periodOf(''), null);
    assert.equal(periodOf(undefined), null);
    assert.equal(READ_PERIODS.length, 9);
    assert.equal(new Set(READ_PERIODS.map((p) => p.key)).size, 9);
});

test('toReadCard：没有提要，整理本带标记，带年代段／子类／文本数／work_id', () => {
    const c = toReadCard({ id: 'w1', title: '易', description: '很长的提要', juan_count: 2, dynasty: '西漢', _classifications: [clsN('經部', '易類')], authors: [{ name: '甲' }] }, { collated: true, textCount: 3 });
    assert.deepEqual(c, {
        id: 'w1', title: '易', juan: 2, authors: [{ name: '甲', dynasty: '西漢' }], collated: true,
        classification: ['經部', '易類'], period: 'qinhan', text_count: 3,
    });
    const p = toReadCard({ id: 'w2', title: '師說', subtype: 'article', authors: [{ name: '韓愈', dynasty: '唐' }] });
    assert.equal(p.subtype, 'article');
    assert.equal(p.period, 'suitang');
    assert.equal(p.text_count, 1);
    assert.equal('collated' in p, false);
    assert.equal('subtype' in toReadCard({ id: 'w3', title: '書', subtype: 'book' }), false); // 书不写
    assert.equal('period' in toReadCard({ id: 'w4', title: '書' }), false); // 无朝代不写
    assert.equal(toReadCard({ id: 'b1', title: '本', work_id: ' w1 ' }).work_id, 'w1');
});

test('toReadCard：带版本名（Book 的 edition），空白版本名不带', () => {
    assert.equal(toReadCard({ id: 'b1', title: '石頭記', edition: ' 甲戌本 ' }).edition, '甲戌本');
    assert.equal('edition' in toReadCard({ id: 'b2', title: '石頭記', edition: '  ' }), false);
    assert.equal('edition' in toReadCard({ id: 'b3', title: '石頭記' }), false);
});

test('compareReadCards：整理本在前，再按书名拼音，再按 id；comparePeriodCards：书在前、单篇在后', () => {
    const list = [
        { id: 'c', title: '乙' },
        { id: 'b', title: '甲', collated: true },
        { id: 'a', title: '甲' },
    ].sort(compareReadCards);
    assert.deepEqual(list.map((x) => x.id), ['b', 'a', 'c']);
    const pl = [
        { id: 'p', title: '甲', subtype: 'poem' },
        { id: 'q', title: '乙' },
        { id: 'r', title: '丙', subtype: 'chapter' },
    ].sort(comparePeriodCards);
    assert.deepEqual(pl.map((x) => x.id), ['r', 'q', 'p']);
});

test('readCuration：没有文件返回 null；坏 JSON 警告并返回 null；规整各段、跳过认不出的项', () => {
    const root = mkdtempSync(join(tmpdir(), 'read-cur-'));
    try {
        assert.equal(readCuration(join(root, 'none.json')), null);
        assert.equal(readCuration(null), null);
        const bad = join(root, 'bad.json');
        writeFileSync(bad, '{ not json');
        const logs = [];
        assert.equal(readCuration(bad, (s) => logs.push(s)), null);
        assert.match(logs[0], /策展文件读不了/);
        const ok = join(root, 'ok.json');
        writeFileSync(ok, JSON.stringify({
            picks: [{ id: 'a', blurb: ' 导语 ', slip: '題' }, { blurb: '没有 id' }, 'b'],
            topics: [{ key: 't', label: '組', shelf: true, items: ['a', { id: 'b', period_of: '晉', orig: true }, {}] }, { key: 'x' }],
            famous: [{ title: '紅樓夢', systems: [{ label: '脂本', items: [{ id: 'a', short: '甲戌本' }] }] }, { title: '平鋪', work_id: 'w' }, { nope: 1 }],
        }));
        const c = readCuration(ok);
        assert.deepEqual(c.picks.map((p) => p.id), ['a', 'b']);
        assert.equal(c.picks[0].blurb, '导语');
        assert.equal(c.topics.length, 1);
        assert.deepEqual(c.topics[0].items, [{ id: 'a', period_of: undefined, orig: false }, { id: 'b', period_of: '晉', orig: true }]);
        assert.equal(c.famous.length, 2);
        assert.equal(c.famous[1].systems, null);
        // 设计稿样例能读
        const s = readCuration(SAMPLE);
        assert.equal(s.picks.length, 6);
        assert.equal(s.topics[0].shelf, true);
        assert.equal(s.famous.length, 6);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('buildSections：策展 id 只收可读的，四部、年代、单篇诗文、计数', () => {
    const w = (id, extra = {}) => ({ id, title: `書${id}`, text_count: 1, ...extra });
    const works = [
        w('a', { period: 'song', authors: [{ name: '甲', dynasty: '宋' }] }),
        w('s1', { subtype: 'article', period: 'suitang', authors: [{ name: '韓愈', dynasty: '唐' }] }),
        w('s2', { subtype: 'poem', period: 'suitang', authors: [{ name: '韓愈' }] }),
        w('s3', { subtype: 'article', period: 'song', authors: [{ name: '蘇軾', dynasty: '北宋' }] }),
        w('s4', { subtype: 'article' }), // 无作者：不进作者分组，但计入单篇总数
    ];
    const books = [
        w('b1', { work_id: 'wz', edition: '甲戌本', text_count: 2 }),
        w('b2', { work_id: 'wz', edition: '程甲本', text_count: 2, period: 'qing' }),
    ];
    const tree = [
        { id: 'c1', label: '經部', count: 9, children: Array.from({ length: 8 }, (_, i) => ({ id: `k${i}`, label: `類${i}`, count: i + 1 })) },
        { id: UNCLASSIFIED_ID, label: '未分類', count: 4 },
    ];
    const curation = {
        picks: [{ id: 'a', blurb: '导语', slip: '題' }, { id: 'gone' }],
        topics: [
            { key: 't1', label: '史志', shelf: true, items: [{ id: 'a', period_of: '宋', orig: true }, { id: 'a' }, { id: 'gone' }] },
            { key: 't2', label: '空組', shelf: false, items: [{ id: 'gone2' }] },
        ],
        famous: [
            { title: '紅樓夢', systems: [{ label: '脂本', items: [{ id: 'b1', short: '甲戌' }] }, { label: '程本', items: [{ id: 'gone' }] }] },
            { title: '平鋪', work_id: 'wz', systems: null },
            { title: '全不可读', systems: [{ label: '', items: [{ id: 'gone' }] }] },
        ],
    };
    const { sections: s, skipped } = buildSections({ works, books, tree, curation });
    assert.deepEqual(s.counts, { readable: 7, works: 5, books: 2, pieces: 4 });
    assert.deepEqual(s.picks.map((p) => [p.id, p.blurb, p.slip]), [['a', '导语', '題']]);
    assert.equal(s.topics.length, 1); // 空組整组不出
    assert.deepEqual(s.topics[0].items.map((x) => x.id), ['a']); // 去重、不可读的略过
    assert.equal(s.topics[0].items[0].period_of, '宋');
    assert.equal(s.topics[0].items[0].orig, true);
    assert.equal(s.topics[0].shelf, true);
    assert.equal(s.famous.length, 2);
    assert.deepEqual(s.famous[0].systems, [{ label: '脂本', items: [{ id: 'b1', short: '甲戌', title: '書b1', edition: '甲戌本' }] }]);
    assert.equal(s.famous[0].text_count, 1);
    assert.deepEqual(s.famous[1].systems[0].items.map((x) => [x.id, x.short]), [['b1', '甲戌本'], ['b2', '程甲本']]);
    assert.deepEqual(skipped.sort(), ['gone', 'gone2']);
    // 四部：前 6 个子类按数量降序
    assert.equal(s.bu.length, 1);
    assert.equal(s.bu[0].children_total, 8);
    assert.deepEqual(s.bu[0].top.map((k) => k.count), [8, 7, 6, 5, 4, 3]);
    assert.equal(s.unclassified, 4);
    // 年代：9 段都出（0 也出），无朝代单计
    assert.equal(s.periods.length, 9);
    assert.equal(s.periods.find((p) => p.key === 'song').count, 2);
    assert.equal(s.periods.find((p) => p.key === 'suitang').count, 2);
    assert.equal(s.periods.find((p) => p.key === 'qing').count, 1);
    assert.equal(s.period_unknown, 2); // s4、b1
    // 单篇诗文：按第一作者分组，篇多的在前；朝代取组里有的
    assert.equal(s.pieces.count, 4);
    assert.deepEqual(s.pieces.authors.map((a) => [a.name, a.dynasty, a.count]), [['韓愈', '唐', 2], ['蘇軾', '北宋', 1]]);
    // 没有策展文件：三块为空数组，其余照常
    const none = buildSections({ works, books, tree, curation: null }).sections;
    assert.deepEqual([none.picks, none.topics, none.famous], [[], [], []]);
    assert.equal(none.counts.readable, 7);
});

/** 测试仓：draft 元数据＋book-text 新结构 */
function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'read-idx-'));
    const draft = join(root, 'draft');
    const text = join(root, 'text');
    const out = join(root, 'out');
    const put = (base, rel, data) => {
        const p = join(base, rel);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data));
    };
    /** 新结构文本：versions＝[{ key, kind, chapters }]（chapters 为空表示目录空） */
    const texts = (type, id, versions) => {
        put(text, `${type}/${id}/manifest.json`, { id, versions: versions.map(({ key, kind, visibility }) => ({ key, kind, label: key, ...(visibility ? { visibility } : {}) })) });
        for (const v of versions) put(text, `${type}/${id}/${v.key}/index.json`, { chapters: v.chapters ?? [{ n: 1, file: '001', title: '卷一' }] });
    };
    const works = {};
    const add = (id, detail, versions) => {
        const path = `Work/${id}.json`;
        put(draft, path, { id, title: `書${id}`, ...detail });
        works[id] = { id, path, _root: 'draft' };
        if (versions) texts('Work', id, versions);
    };
    const books = {};
    const addBook = (id, detail, versions) => {
        const path = `Book/${id}.json`;
        put(draft, path, { id, title: `本${id}`, ...detail });
        books[id] = { id, path, _root: 'draft' };
        if (versions) texts('Book', id, versions);
    };
    const T = [{ key: 'default', kind: 'transcription' }];
    add('wc', { _classifications: [clsN('史部', '正史類')], dynasty: '東漢' }, [{ key: 'default', kind: 'collated' }, { key: 'wikisource', kind: 'transcription' }]);
    add('wt', { _classifications: [clsN('史部', '正史類')] }, T);
    add('wn', { _classifications: [clsN('史部', '正史類')], has_text: true }); // 只有外部资源标记、站内无正文：不可读（overview#306）
    add('wu', {}, T); // 未分類
    add('wm', { _classifications: [clsN('經部')], merged_into: 'wc' }, T); // 被并
    add('wd', { _classifications: [clsN('經部')] }, T);
    add('wz', { _classifications: [clsN('經部')] }, [{ key: 'default', kind: 'transcription', chapters: [] }]); // 目录空：不可读
    add('wi', { _classifications: [clsN('經部')] }, [{ key: 'default', kind: 'transcription', visibility: 'internal' }]); // 只有私有版本：不可读
    add('wr', { title: '紅樓夢', authors: [{ name: '曹雪芹' }], dynasty: '清' }); // 自身无文本，但有可读 Book
    add('sp', { subtype: 'poem', authors: [{ name: '李白', dynasty: '唐' }] }, T);
    for (let i = 0; i < 25; i++) add(`p${String(i).padStart(2, '0')}`, { _classifications: [clsN('子部', '儒家類')], dynasty: '宋' }, T);
    addBook('bt', { has_text: true }); // 只有外部资源标记：不可读
    addBook('bf', { work_id: 'wc' }, T);
    addBook('be', {}, [{ key: 'default', kind: 'transcription', chapters: [] }]); // 目录空：不可读
    addBook('bn', {});
    addBook('r1', { work_id: 'wr', edition: '甲戌本' }, T); // 作者无朝代：借 Work 的
    addBook('r2', { work_id: 'wr', edition: '程甲本' }, [...T, { key: 'wikisource', kind: 'transcription' }]);
    mkdirSync(out, { recursive: true });
    return { root, out, draft, text, put, index: { works, books }, rootDirFor: () => draft, textDirFor: () => text };
}

test('bundleRead：只收新结构可读条目，节点 id 与总目一致，未分類在最后，精选清单与分页写盘', () => {
    const f = fixture();
    try {
        const r = bundleRead({ ...f, dataDir: f.out, curationFile: null, log: () => {} });
        const tree = json(join(f.out, 'read/tree.json'));
        assert.deepEqual(tree.map((n) => n.label), ['經部', '史部', '子部', '未分類']);
        const shi = tree.find((n) => n.label === '史部');
        assert.equal(shi.id, nodeIdFor(['史部']));
        assert.equal(shi.count, 2); // wc、wt；wn 站内无正文不可读
        assert.equal(shi.children[0].id, nodeIdFor(['史部', '正史類']));
        assert.equal(tree.at(-1).id, UNCLASSIFIED_ID);
        assert.equal(tree.find((n) => n.label === '經部').count, 1); // 只有 wd：被并的 wm、目录空的 wz、私有的 wi 都不算

        // 有整理本在前；text_count＝自身可读版本数＋同 work_id 的可读 Book 数
        const p1 = json(join(f.out, `read/${shi.id}/1.json`));
        assert.deepEqual(p1.map((c) => c.id), ['wc', 'wt']);
        assert.equal(p1[0].collated, true);
        assert.equal(p1[0].text_count, 3); // 2 个版本＋bf
        assert.equal(p1[0].period, 'qinhan');
        assert.equal(p1[1].text_count, 1);

        // 25 部子部 → 2 页（每页 READ_PAGE_SIZE）
        const zi = tree.find((n) => n.label === '子部');
        assert.equal(zi.count, 25);
        assert.equal(json(join(f.out, `read/${zi.id}/1.json`)).length, READ_PAGE_SIZE);
        assert.equal(json(join(f.out, `read/${zi.id}/2.json`)).length, 25 - READ_PAGE_SIZE);
        assert.equal(existsSync(join(f.out, `read/${zi.id}/3.json`)), false);

        const feat = json(join(f.out, 'read/featured.json'));
        assert.deepEqual(feat.collated.map((c) => c.id), ['wc']);
        assert.deepEqual(feat.books.map((c) => c.id).sort(), ['bf', 'r1', 'r2']); // bt 只有外部资源标记、be 目录空、bn 没文本

        // Book：work_id、text_count（自身版本＋同 work_id 的其他 Book）、年代借 Work
        const r1 = feat.books.find((c) => c.id === 'r1');
        const r2 = feat.books.find((c) => c.id === 'r2');
        assert.equal(r1.work_id, 'wr');
        assert.equal(r1.text_count, 2);
        assert.equal(r2.text_count, 3);
        assert.equal(r1.period, 'qing');
        assert.equal(r.books.length, 3);
    } finally {
        rmSync(f.root, { recursive: true, force: true });
    }
});

test('bundleRead：sections.json 与年代分页；没有策展文件时推荐／专题／名著为空、构建照常', () => {
    const f = fixture();
    try {
        const logs = [];
        bundleRead({ ...f, dataDir: f.out, curationFile: join(f.root, 'none.json'), log: (s) => logs.push(s) });
        const s = json(join(f.out, 'read/sections.json'));
        // 可读：Work wc wt wu wd sp p00–p24（30）＋ Book bf r1 r2（3）
        assert.deepEqual(s.counts, { readable: 33, works: 30, books: 3, pieces: 1 });
        assert.deepEqual([s.picks, s.topics, s.famous], [[], [], []]);
        assert.ok(logs.some((l) => /没有策展文件/.test(l)));
        assert.deepEqual(s.bu.map((b) => b.label), ['經部', '史部', '子部']);
        assert.equal(s.unclassified, 2); // wu、sp
        assert.equal(s.periods.find((p) => p.key === 'song').count, 25);
        assert.equal(s.pieces.authors[0].name, '李白');

        // 年代分页：宋 25 部 → 2 页；清：r1 r2（借 Work 的朝代）
        assert.equal(json(join(f.out, 'read/period/song/1.json')).length, READ_PAGE_SIZE);
        assert.equal(json(join(f.out, 'read/period/song/2.json')).length, 5);
        assert.deepEqual(json(join(f.out, 'read/period/qing/1.json')).map((c) => c.id).sort(), ['r1', 'r2']);
        assert.equal(existsSync(join(f.out, 'read/period/modern')), false); // 没条目的段不出文件
        const st = json(join(f.out, 'read/period/suitang/1.json'));
        assert.deepEqual(st.map((c) => c.id), ['sp']);
    } finally {
        rmSync(f.root, { recursive: true, force: true });
    }
});

test('bundleRead：策展文件默认取 classific.json 同仓的 curation/read-home.json；坏文件不让构建失败', () => {
    const f = fixture();
    try {
        const prod = join(f.root, 'prod');
        f.put(prod, 'classific.json', []);
        f.put(prod, 'curation/read-home.json', {
            picks: [{ id: 'r1', blurb: '脂本', slip: '石頭記', type_label: '小說' }, { id: 'wn', blurb: '不可读' }],
            topics: [{ key: 'shizhi', label: '史志目錄', shelf: true, items: [{ id: 'wc', period_of: '漢', orig: true }] }],
            famous: [{ title: '紅樓夢', systems: [{ label: '脂本', items: [{ id: 'r1', short: '甲戌本' }] }, { label: '程本', items: [{ id: 'r2', short: '程甲本' }] }] }],
        });
        const logs = [];
        bundleRead({ ...f, dataDir: f.out, taxonomyFile: join(prod, 'classific.json'), log: (s) => logs.push(s) });
        const s = json(join(f.out, 'read/sections.json'));
        assert.deepEqual(s.picks.map((p) => [p.id, p.type_label, p.work_id]), [['r1', '小說', 'wr']]);
        assert.ok(logs.some((l) => /1 个 id 不可读或不存在/.test(l)));
        assert.equal(s.topics[0].items[0].text_count, 3);
        assert.equal(s.topics[0].items[0].orig, true);
        assert.equal(s.famous[0].text_count, 2);
        assert.deepEqual(s.famous[0].systems.map((x) => x.label), ['脂本', '程本']);

        f.put(prod, 'curation/read-home.json', '{ 坏');
        bundleRead({ ...f, dataDir: f.out, taxonomyFile: join(prod, 'classific.json'), log: () => {} });
        assert.deepEqual(json(join(f.out, 'read/sections.json')).picks, []);
    } finally {
        rmSync(f.root, { recursive: true, force: true });
    }
});

test('bundleRead：重跑不留旧文件（作品不再可读后其页文件被删）', () => {
    const f = fixture();
    try {
        bundleRead({ ...f, dataDir: f.out, curationFile: null, log: () => {} });
        assert.equal(existsSync(join(f.out, 'read/featured.json')), true);
        assert.equal(existsSync(join(f.out, 'read/period/song/2.json')), true);
        // 去掉全部 p* 作品
        for (const id of Object.keys(f.index.works)) if (id.startsWith('p')) delete f.index.works[id];
        const r = bundleRead({ ...f, dataDir: f.out, curationFile: null, log: () => {} });
        assert.ok(r.written.removed >= 4);
        const tree = json(join(f.out, 'read/tree.json'));
        assert.equal(tree.find((n) => n.label === '子部'), undefined);
        assert.equal(existsSync(join(f.out, 'read/period/song')), false);
    } finally {
        rmSync(f.root, { recursive: true, force: true });
    }
});

test('verifyReadProbes：对读章声明 char_file 时核对 char.json，不要求 txt', () => {
    const root = mkdtempSync(join(tmpdir(), 'probe-char-'));
    try {
        mkdirSync(join(root, 'items', 'w1', 'default'), { recursive: true });
        writeFileSync(join(root, 'items', 'w1', 'default', 'index.json'), '{}');
        const probe = { id: 'w1', kind: 'text', key: 'default', first: { file: '002', hasJson: false, charFile: '002.char.json' } };
        assert.match(verifyReadProbes([probe], root)[0], /default\/002\.char\.json/);
        writeFileSync(join(root, 'items', 'w1', 'default', '002.char.json'), '{}');
        assert.deepEqual(verifyReadProbes([probe], root), []);
    } finally { rmSync(root, { recursive: true, force: true }); }
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
        // file 带扩展名（规格不允许，数据 0 例）不再被悄悄容忍：报缺而不是放过
        assert.match(verifyReadProbes([{ id: 'w1', kind: 'text', key: 'default', first: { file: '001.md', hasJson: true } }], root)[0], /default\/001\.md\.json/);
        // manifest 缺
        assert.match(verifyReadProbes([{ id: 'w2', kind: 'manifest' }], root)[0], /w2: items\/w2\/manifest\.json/);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('bundleRead verifyItems：产物里缺数据文件则构建失败，全在则通过', () => {
    const f = fixture();
    try {
        // 产物里什么都没有 → 抛错并列出缺失
        assert.throws(() => bundleRead({ ...f, dataDir: f.out, curationFile: null, verifyItems: true, log: () => {} }), /阅读卡片对应的数据文件在产物里缺失/);
        // 把文本仓的新结构按 bundle-data 的做法复制进产物（.md → .txt）
        const put = (rel, data) => { const p = join(f.out, 'items', rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, data); };
        const ids = ['wc', 'wt', 'wu', 'wd', 'sp', 'bf', 'r1', 'r2', ...Array.from({ length: 25 }, (_, i) => `p${String(i).padStart(2, '0')}`)];
        for (const id of ids) {
            put(`${id}/manifest.json`, '{}');
            for (const key of ['default', 'wikisource']) {
                put(`${id}/${key}/index.json`, '{}');
                put(`${id}/${key}/001.txt`, '正文');
            }
        }
        const r = bundleRead({ ...f, dataDir: f.out, curationFile: null, verifyItems: true, log: () => {} });
        assert.equal(r.books.length, 3);
    } finally {
        rmSync(f.root, { recursive: true, force: true });
    }
});

test('设计稿样例 read-home.sample.json：结构合法（推荐 6、专题 7 组含史志书架、名著 6）', () => {
    const s = json(SAMPLE);
    assert.equal(s.picks.length, 6);
    assert.deepEqual(s.topics.map((t) => t.key), ['shizhi', 'bibliography', 'congshu', 'archives', 'history', 'anthologies', 'zishu']);
    assert.ok(s.topics[0].items.every((x) => typeof x.id === 'string' && typeof x.period_of === 'string'));
    assert.equal(s.famous.length, 6);
    // 页面不出现旧称（用户 10-01）
    assert.equal(/整理本|轉錄全文|转录全文|全文/.test(JSON.stringify(s)), false);
});

test('readCuration：layout: shelf 等同 shelf: true（目录总管 10-01 实交写法），阅读首页因此不出史志书架', () => {
    const root = mkdtempSync(join(tmpdir(), 'read-cur-layout-'));
    try {
        const file = join(root, 'read-home.json');
        writeFileSync(file, JSON.stringify({ topics: [
            { key: 'shizhi', label: '史志目录', layout: 'shelf', items: [{ id: 'a', period_of: '漢', orig: true }] },
            { key: 'shumu', label: '书目与考证', layout: 'list', items: [{ id: 'b' }] },
        ] }));
        const c = readCuration(file, () => {});
        assert.deepEqual(c.topics.map((t) => [t.key, t.shelf]), [['shizhi', true], ['shumu', false]]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
