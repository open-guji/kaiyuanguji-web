#!/usr/bin/env node
/**
 * build-meta-home.test.mjs — 元数据首页分区数据（overview#322）的脚本单测（不进 jest）。
 *
 * 覆盖：存佚计数（详情优先、索引兜底、被并不计）、谱系判定（version_graph.enabled／lineage_graph.json）、
 * 书架与同类书目沿用 read-home.json、著录进度（旧式 id 不给链接、对上了才标书脊条目数）、丛编分组、
 * 目录学家、谱系名单只收有谱系的、在线资源（只放 http(s) 链接）、四部、策展文件缺失／坏了不失败。
 *
 * 用法：node --test scripts/build-meta-home.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { bundleMetaHome, hasLineage, lossKey, readMetaCuration } from './build-meta-home.mjs';

const json = (p) => JSON.parse(readFileSync(p, 'utf-8'));

test('lossKey：详情优先，索引条目兜底，认不出的算 unknown', () => {
    assert.equal(lossKey({ loss_status: 'lost' }, { loss_status: 'extant' }), 'lost');
    assert.equal(lossKey({}, { loss_status: 'partially_extant' }), 'partially_extant');
    assert.equal(lossKey({ loss_status: '佚' }, {}), 'unknown');
    assert.equal(lossKey(null, null), 'unknown');
});

test('hasLineage：version_graph.enabled 为 true，或有 lineage_graph.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-lin-'));
    try {
        mkdirSync(join(root, 'a'), { recursive: true });
        writeFileSync(join(root, 'a', 'lineage_graph.json'), '{}');
        assert.equal(hasLineage({ version_graph: { enabled: true } }, null), true);
        assert.equal(hasLineage({ version_graph: { enabled: false } }, join(root, 'b')), false);
        assert.equal(hasLineage({}, join(root, 'a')), true);
        assert.equal(hasLineage(null, join(root, 'none')), false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test('readMetaCuration：没有文件 null；坏 JSON 警告并 null；规整三段', () => {
    const root = mkdtempSync(join(tmpdir(), 'mh-cur-'));
    try {
        assert.equal(readMetaCuration(join(root, 'none.json')), null);
        writeFileSync(join(root, 'bad.json'), '{坏');
        const logs = [];
        assert.equal(readMetaCuration(join(root, 'bad.json'), (s) => logs.push(s)), null);
        assert.match(logs[0], /策展文件读不了/);
        writeFileSync(join(root, 'ok.json'), JSON.stringify({
            collection_groups: [{ key: 'qige', label: '四庫七閣', items: ['c1', { id: 'c2' }, 3] }, { key: 'x' }],
            bibliographers: ['e1', { id: 'e2' }, ''],
            lineage_picks: ['w1'],
        }));
        const c = readMetaCuration(join(root, 'ok.json'));
        assert.deepEqual(c.collection_groups, [{ key: 'qige', label: '四庫七閣', items: ['c1', 'c2'] }]);
        assert.deepEqual(c.bibliographers, ['e1', 'e2']);
        assert.deepEqual(c.lineage_picks, ['w1']);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'mh-'));
    const draft = join(root, 'draft');
    const text = join(root, 'text');
    const out = join(root, 'out');
    const cur = join(root, 'curation');
    const put = (base, rel, data) => {
        const p = join(base, rel);
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data));
    };
    const works = {};
    const addWork = (id, detail, entry = {}) => {
        const path = `Work/${id}.json`;
        put(draft, path, { id, title: `書${id}`, ...detail });
        works[id] = { id, path, title: `書${id}`, ...entry };
    };
    addWork('hz', { title: '漢書藝文志', authors: [{ name: '班固' }], dynasty: '東漢', loss_status: 'extant' });
    addWork('bj', { title: '補晉書藝文志', loss_status: 'extant' });
    addWork('zz', { title: '直齋書錄解題', authors: [{ name: '陳振孫', dynasty: '南宋' }] }, { loss_status: 'extant' }); // 详情无、索引兜底
    addWork('lw', { title: '佚書', loss_status: 'lost' });
    addWork('pw', { title: '殘書' }, { loss_status: 'partially_extant' });
    addWork('mg', { merged_into: 'hz', loss_status: 'lost' }); // 被并：不计
    addWork('hl', { title: '紅樓夢', version_graph: { enabled: true } });
    addWork('sj', { title: '史記' }); // 谱系在文本目录的 lineage_graph.json
    put(text, 'Work/sj/lineage_graph.json', {});
    addWork('xy', { title: '西遊記' }); // 没谱系
    const index = {
        works,
        books: { b1: {}, b2: {} },
        collections: { c1: { title: '欽定四庫全書·文淵閣本' }, c2: { title: '欽定四庫全書·文津閣本' } },
        entities: {
            e1: { primary_name: '劉向', dynasty: '西漢', birth_year: -77, death_year: -6 },
            e2: { primary_name: '班固', dynasty: '東漢' },
        },
    };
    put(out, 'meta.json', { works: 95055, books: 20899, collections: 84, entities: 30994, resourceCounts: { hasText: 11517, hasImage: 17415 }, subtypeStats: { article: 2525, poem: 320 } });
    put(out, 'catalog/tree.json', [
        { id: 'cj', label: '經部', count: 13065, children: [{ id: 'k1', label: '易類', count: 3 }, { id: 'k2', label: '詩類', count: 9 }] },
        { id: 'unclassified', label: '未分類', count: 41804 },
    ]);
    put(draft, 'resource.json', { resources: [
        { id: 'hanzhi', name: '漢書藝文志', type: 'catalog', work_id: 'hz', total: 621, imported: 549, status: 'done' },
        { id: 'siku', name: '欽定四庫全書總目', type: 'catalog', work_id: '1eujf2fs4v280', total: 10687, imported: 10687, status: 'done' }, // 旧式 id
        { id: 'wenyuan', name: '欽定四庫全書', edition: '文淵閣本', type: 'catalog', collection_id: 'c1', total: 4172, imported: 4172, status: 'done' },
        { id: 'other', name: '別的', type: 'collection', total: 1 },
    ] });
    put(draft, 'resource-site.json', { resources: [
        { id: 'ctext', name: 'CText', url: 'https://ctext.org/', total: 11381, imported: 5700, status: 'done' },
        { id: 'bad', name: '壞鏈', url: 'javascript:alert(1)', total: 1, imported: 0, status: 'todo' },
    ] });
    put(cur, 'read-home.json', { topics: [
        { key: 'shizhi', label: '史志目錄', shelf: true, items: [{ id: 'hz', period_of: '漢', orig: true }, { id: 'bj', period_of: '晉' }, { id: 'gone', period_of: '宋' }] },
        { key: 'bibliography', label: '書目與考證', items: ['zz'] },
    ] });
    put(cur, 'meta-home.json', {
        collection_groups: [{ key: 'qige', label: '四庫七閣', items: ['c1', 'c2', 'cx'] }, { key: 'empty', label: '空', items: ['cy'] }],
        bibliographers: ['e1', 'e2', 'ex'],
        lineage_picks: ['hl', 'sj', 'xy', 'wx'],
    });
    mkdirSync(out, { recursive: true });
    return { root, draft, text, out, cur, put, index };
}

test('bundleMetaHome：各分区按现有数据拼出，策展里不存在或不合条件的 id 略过', () => {
    const f = fixture();
    try {
        const logs = [];
        bundleMetaHome({ index: f.index, rootDirFor: () => f.draft, textDirFor: () => f.text, dataDir: f.out, draftDir: f.draft, curationDir: f.cur, log: (s) => logs.push(s) });
        const s = json(join(f.out, 'meta-home/sections.json'));
        assert.deepEqual(s.counts, { works: 95055, books: 20899, collections: 84, entities: 30994 });
        // 书架：按全部作品解析，点名的不存在就略过；对上了著录进度才标条目数
        assert.equal(s.shelf.label, '史志目錄');
        assert.deepEqual(s.shelf.items.map((x) => [x.id, x.period_of, x.orig ?? false, x.records ?? null]), [['hz', '漢', true, 621], ['bj', '晉', false, null]]);
        assert.equal(s.shelf.items[0].title, '漢書藝文志');
        assert.deepEqual(s.related_catalogs.map((x) => [x.id, x.title, x.authors?.[0]?.dynasty]), [['zz', '直齋書錄解題', '南宋']]);
        // 著录进度：只要 catalog；旧式 id 不给链接
        assert.deepEqual(s.catalog_progress.map((r) => [r.id, r.work_id ?? null, r.collection_id ?? null]), [['hanzhi', 'hz', null], ['siku', null, null], ['wenyuan', null, 'c1']]);
        assert.equal(s.catalog_progress[2].edition, '文淵閣本');
        // 丛编：空组不出
        assert.deepEqual(s.collection_groups, [{ key: 'qige', label: '四庫七閣', items: [{ id: 'c1', title: '欽定四庫全書·文淵閣本' }, { id: 'c2', title: '欽定四庫全書·文津閣本' }] }]);
        // 人物：生卒年缺的照样列（页面不上轴、轴下注明）
        assert.deepEqual(s.bibliographers, [{ id: 'e1', name: '劉向', dynasty: '西漢', birth_year: -77, death_year: -6 }, { id: 'e2', name: '班固', dynasty: '東漢' }]);
        // 谱系：只收真有谱系的
        assert.deepEqual(s.lineage.map((x) => x.id), ['hl', 'sj']);
        // 在线资源：非 http(s) 链接不给
        assert.equal(s.sites[0].url, 'https://ctext.org/');
        assert.equal('url' in s.sites[1], false);
        // 四部
        assert.equal(s.bu[0].label, '經部');
        assert.deepEqual(s.bu[0].top.map((k) => k.label), ['詩類', '易類']);
        assert.equal(s.unclassified, 41804);
        // 统计与存佚（被并的不计）
        assert.deepEqual(s.stats.loss, { extant: 3, partially_extant: 1, lost: 1, unknown: 3 });
        assert.equal(s.stats.has_image, 17415);
        assert.equal(s.stats.article, 2525);
        assert.ok(logs.some((l) => /个 id 不存在或不合条件/.test(l) && /gone/.test(l) && /xy/.test(l)));
        assert.ok(logs.some((l) => /1 条 id 对不上、不加链接/.test(l)));
    } finally {
        rmSync(f.root, { recursive: true, force: true });
    }
});

test('bundleMetaHome：策展文件缺失或坏了，书架／丛编／人物／谱系为空，其余照常，构建不失败', () => {
    const f = fixture();
    try {
        rmSync(join(f.cur, 'meta-home.json'));
        f.put(f.cur, 'read-home.json', '{坏');
        bundleMetaHome({ index: f.index, rootDirFor: () => f.draft, textDirFor: () => f.text, dataDir: f.out, draftDir: f.draft, curationDir: f.cur, log: () => {} });
        const s = json(join(f.out, 'meta-home/sections.json'));
        assert.equal(s.shelf, null);
        assert.deepEqual([s.related_catalogs, s.collection_groups, s.bibliographers, s.lineage], [[], [], [], []]);
        assert.equal(s.catalog_progress.length, 3);
        assert.equal(s.sites.length, 2);
        assert.equal(s.bu.length, 1);
        // 没有 resource 文件、没有 tree 也不失败
        rmSync(join(f.draft, 'resource.json'));
        rmSync(join(f.out, 'catalog'), { recursive: true });
        bundleMetaHome({ index: f.index, rootDirFor: () => f.draft, textDirFor: () => f.text, dataDir: f.out, draftDir: f.draft, curationDir: null, log: () => {} });
        const s2 = json(join(f.out, 'meta-home/sections.json'));
        assert.deepEqual([s2.catalog_progress, s2.bu], [[], []]);
    } finally {
        rmSync(f.root, { recursive: true, force: true });
    }
});

// 目录总管 10-01 实交的 curation/read-home.json：书架组写 layout: 'shelf'（不是 shelf: true），书目组 key 是 shumu。
// 测试站曾因此出 shelf: null、related_catalogs: []（overview#322）
test('bundleMetaHome：认实交格式——layout: shelf 的组是书架，shumu 组是同类书目', () => {
    const f = fixture();
    try {
        f.put(f.cur, 'read-home.json', { schema: 'read-home/1', topics: [
            { key: 'shizhi', label: '史志目录', layout: 'shelf', items: [
                { id: 'hz', kind: 'Work', title: '漢書·藝文志', period_of: '漢', orig: true, text_count: 2 },
                { id: 'bj', kind: 'Work', title: '補晉書藝文志', period_of: '晉', orig: false, text_count: 1 },
            ] },
            { key: 'shumu', label: '书目与考证', layout: 'list', items: [{ id: 'zz', kind: 'Work', title: '直齋書錄解題', text_count: 2 }] },
            { key: 'dangan', label: '档案', layout: 'list', items: [{ id: 'hl', kind: 'Work' }] },
        ] });
        bundleMetaHome({ index: f.index, rootDirFor: () => f.draft, textDirFor: () => f.text, dataDir: f.out, draftDir: f.draft, curationDir: f.cur, log: () => {} });
        const s = json(join(f.out, 'meta-home/sections.json'));
        assert.equal(s.shelf.label, '史志目录');
        assert.deepEqual(s.shelf.items.map((x) => [x.id, x.period_of, x.orig ?? false, x.records ?? null]), [['hz', '漢', true, 621], ['bj', '晉', false, null]]);
        assert.deepEqual(s.related_catalogs.map((x) => x.id), ['zz']);
    } finally {
        rmSync(f.root, { recursive: true, force: true });
    }
});
