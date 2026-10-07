/**
 * data-contract.test.mjs — 格式契约校验器（ops/data-contract.mjs）。
 * 用法：node --test ops/tests/data-contract.test.mjs
 * 夹具：ops/tests/fixtures/data-contract/（旧格式线上条目、book-index schema-v2 的 contract-sample）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    checkEntryDoc, checkMeta, checkVersion, checkLatest, checkTree, checkTextIndexShard, checkTextManifest, checkMetaHome,
    ENTRY_TYPES, ENTRY_FIELD_TYPES, jsType,
} from '../data-contract.mjs';

const FX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'data-contract');
const load = (rel) => JSON.parse(readFileSync(join(FX, rel), 'utf-8'));
const entries = (dir) => readdirSync(join(FX, dir, 'entry')).filter((f) => f.endsWith('.json')).map((f) => [f, load(`${dir}/entry/${f}`)]);
const blocks = (r) => r.findings.filter((f) => f.severity === 'block');
const codes = (r) => r.findings.map((f) => f.code);

test('夹具：旧格式 6 个、新格式 26 个，四种 type 都有', () => {
    assert.equal(entries('old').length, 6);
    assert.equal(entries('v2').length, 26);
    for (const dir of ['old', 'v2']) {
        const types = new Set(entries(dir).map(([, d]) => d.type));
        for (const t of ENTRY_TYPES) assert.ok(types.has(t), `${dir} 缺 ${t}`);
    }
});

test('旧格式（线上现在的）条目全部通过：没有 block，也没有字段类型警告', () => {
    for (const [file, doc] of entries('old')) {
        const r = checkEntryDoc(doc, file);
        assert.deepEqual(blocks(r), [], `${file}: ${JSON.stringify(r.findings)}`);
        assert.deepEqual(r.findings.filter((f) => f.code === 'entry.field-type'), [], file);
    }
});

test('新格式（schema-v2 build 产物）条目全部通过：多出来的是 `_` 起首的派生字段，不算错', () => {
    for (const [file, doc] of entries('v2')) {
        const r = checkEntryDoc(doc, file);
        assert.deepEqual(blocks(r), [], `${file}: ${JSON.stringify(r.findings)}`);
        assert.deepEqual(r.findings.filter((f) => f.code === 'entry.field-type'), [], file);
        // 字段表已收齐 schema-v2 样例（含 `_` 起首的派生字段）里的全部字段：没有「未知字段」
        assert.deepEqual(r.unknownFields, [], `${file} 有字段表里没有的字段`);
    }
});

test('旧格式里没有 schema_version 的老 book 不报错（schema_version 不是必有字段）', () => {
    const doc = load('old/entry/96kzirvbwg.json');
    assert.equal(doc.schema_version, undefined);
    assert.deepEqual(blocks(checkEntryDoc(doc, '96kzirvbwg.json')), []);
});

test('缺 type／未知 type／缺 id／id 与文件名不一致／缺名字：block', () => {
    const base = load('old/entry/0phe8c4i1i.json');
    const f = '0phe8c4i1i.json';
    const mut = (patch) => checkEntryDoc({ ...base, ...patch }, f);
    assert.ok(codes(mut({ type: undefined })).includes('entry.type-missing'));
    assert.ok(codes(mut({ type: 'banana' })).includes('entry.type-unknown'));
    assert.ok(codes(mut({ id: undefined })).includes('entry.id-missing'));
    assert.ok(codes(mut({ id: 'zzz' })).includes('entry.id-filename'));
    assert.ok(codes(mut({ title: '' })).includes('entry.name-missing'));
    const ent = load('old/entry/hixhd2h9bk4b.json');
    assert.ok(codes(checkEntryDoc({ ...ent, primary_name: undefined }, 'hixhd2h9bk4b.json')).includes('entry.name-missing'));
    assert.ok(!codes(checkEntryDoc({ ...ent, title: undefined }, 'hixhd2h9bk4b.json')).includes('entry.name-missing'), 'entity 看的是 primary_name，不是 title');
    // 以上每一种都是 block 级
    for (const patch of [{ type: undefined }, { type: 'banana' }, { id: undefined }, { id: 'zzz' }, { title: '' }]) {
        assert.ok(blocks(mut(patch)).length >= 1, JSON.stringify(patch));
    }
});

test('根不是对象：block', () => {
    for (const bad of [null, [], 'x', 3]) assert.ok(codes(checkEntryDoc(bad, 'a.json')).includes('entry.not-object'));
});

test('字段类型变了：warn（字段表里有的字段）；book 没有 work_id：warn', () => {
    const base = load('old/entry/0phe8c4i1i.json');
    const r = checkEntryDoc({ ...base, authors: 'someone', has_image: 'yes' }, '0phe8c4i1i.json');
    const ft = r.findings.filter((f) => f.code === 'entry.field-type');
    assert.deepEqual(ft.map((f) => f.field).sort(), ['authors', 'has_image']);
    assert.ok(ft.every((f) => f.severity === 'warn'));
    const noWork = checkEntryDoc({ ...base, work_id: undefined }, '0phe8c4i1i.json');
    assert.ok(noWork.findings.some((f) => f.code === 'entry.book-work_id' && f.severity === 'warn'));
});

test('字段表里的类型都是合法类型名；jsType 区分数组、对象、null', () => {
    for (const [k, t] of Object.entries(ENTRY_FIELD_TYPES)) assert.ok(['string', 'number', 'boolean', 'array', 'object', 'any'].includes(t), `${k}: ${t}`);
    assert.equal(jsType([]), 'array');
    assert.equal(jsType(null), 'null');
    assert.equal(jsType({}), 'object');
});

test('null 视为「没填」不判类型（线上旧数据里 period／dynasty／juan_count 等有 null）；类型不固定的字段（merged_from）不判', () => {
    const base = load('old/entry/0phe8c4i1i.json');
    const r = checkEntryDoc({ ...base, juan_count: null, period: null, dynasty: null, birth_year: null, merged_from: 'x' }, '0phe8c4i1i.json');
    assert.deepEqual(r.findings.filter((f) => f.code === 'entry.field-type'), []);
    assert.equal(ENTRY_FIELD_TYPES.merged_from, 'any');
    // 线上全量旧数据里出现过的字段都在表里（没有「未知字段」）——抽样夹具里的字段全部已知
    for (const [file, doc] of entries('old')) assert.deepEqual(checkEntryDoc(doc, file).unknownFields, [], file);
});

test('未知字段分两类上报：非 `_` 的、`_` 起首的', () => {
    const base = load('old/entry/0phe8c4i1i.json');
    const r = checkEntryDoc({ ...base, brand_new_field: 1, _new_derived: [] }, '0phe8c4i1i.json');
    assert.ok(r.unknownFields.includes('brand_new_field'));
    assert.ok(r.unknownFields.includes('_new_derived'));
});

test('meta.json：线上真实 meta 通过；计数缺失／负数／subtypeStats 之和不等于 works：block', () => {
    const meta = load('old/meta.json');
    assert.deepEqual(checkMeta(meta), []);
    assert.ok(checkMeta({ ...meta, works: undefined }).some((f) => f.code === 'meta.count'));
    assert.ok(checkMeta({ ...meta, books: -1 }).some((f) => f.code === 'meta.count'));
    assert.ok(checkMeta({ ...meta, subtypeStats: { book: 1 } }).some((f) => f.code === 'meta.subtype-sum' && f.severity === 'block'));
    assert.ok(checkMeta({ ...meta, resourceCounts: undefined }).some((f) => f.code === 'meta.resourceCounts'));
    assert.ok(checkMeta([]).some((f) => f.code === 'meta.not-object'));
});

test('version.json／latest.json：线上真实值通过；commit 位数不对、缺 bundleDate：block；dataFormat 必须是整数', () => {
    const v = load('old/version.json');
    const l = load('old/latest.json');
    assert.deepEqual(checkVersion(v), []);
    assert.deepEqual(checkLatest(l, { requireCacheKey: true }), []);
    assert.ok(checkVersion({ ...v, commitId: 'abc' }).some((f) => f.code === 'version.commit'));
    assert.ok(checkLatest({ ...l, commitId: l.fullCommitId }).some((f) => f.code === 'latest.commitId'), 'latest.commitId 必须是 12 位');
    assert.ok(checkLatest({ ...l, productionCommitId: 'x' }).some((f) => f.code === 'latest.commit'));
    assert.ok(checkLatest({ ...l, bundleDate: undefined }).some((f) => f.code === 'latest.bundleDate'));
    assert.ok(checkLatest({ ...l, cacheKey: undefined }, { requireCacheKey: true }).some((f) => f.code === 'latest.cacheKey'));
    assert.deepEqual(checkLatest({ ...l, dataFormat: 2 }), []);
    assert.ok(checkLatest({ ...l, dataFormat: '2' }).some((f) => f.code === 'latest.dataFormat'));
});

test('分类树：合法通过并给出统计；各种坏结构 block', () => {
    const good = [{ id: 'a', label: '經部', count: 10, children: [{ id: 'b', label: '易類', count: 4 }] }, { id: 'c', label: '史部', count: 5 }];
    const r = checkTree(good, 'read/tree.json');
    assert.deepEqual(r.findings, []);
    assert.deepEqual([r.topCount, r.nodes, r.countSum], [2, 3, 15]);
    assert.ok(checkTree({}, 't').findings.some((f) => f.code === 'tree.not-array'));
    assert.ok(checkTree([], 't').findings.some((f) => f.code === 'tree.empty'));
    assert.ok(checkTree([{ id: 'a', label: 'x', count: -1 }], 't').findings.some((f) => f.code === 'tree.node-count'));
    assert.ok(checkTree([{ id: '', label: 'x', count: 1 }], 't').findings.some((f) => f.code === 'tree.node-id'));
    assert.ok(checkTree([{ id: 'a', label: '', count: 1 }], 't').findings.some((f) => f.code === 'tree.node-label'));
    assert.ok(checkTree([{ id: 'a', label: 'x', count: 1, children: {} }], 't').findings.some((f) => f.code === 'tree.children'));
    assert.ok(checkTree([null], 't').findings.some((f) => f.code === 'tree.node'));
});

test('文本索引分片与阅读清单：线上形态通过，缺 key／空列表／id 对不上 block', () => {
    const shard = { d59f2ho5z08x: [{ key: 'default', kind: 'transcription', label: '維基文庫', chapters_total: 1 }] };
    const r = checkTextIndexShard(shard, '0.json');
    assert.deepEqual([r.findings.length, r.owners, r.versions], [0, 1, 1]);
    assert.ok(checkTextIndexShard({ a: [] }, '0.json').findings.some((f) => f.code === 'texts-index.versions'));
    assert.ok(checkTextIndexShard({ a: [{ kind: 'x' }] }, '0.json').findings.some((f) => f.code === 'texts-index.version'));
    assert.ok(checkTextIndexShard([], '0.json').findings.some((f) => f.code === 'texts-index.not-object'));
    const manifest = { id: 'd59f20aowb9c', versions: [{ key: 'default', kind: 'transcription', chapters_total: 130 }] };
    assert.deepEqual(checkTextManifest(manifest, 'd59f20aowb9c'), []);
    assert.ok(checkTextManifest(manifest, 'other').some((f) => f.code === 'manifest.id'));
    assert.ok(checkTextManifest({ id: 'x', versions: [] }, 'x').some((f) => f.code === 'manifest.versions'));
    assert.ok(checkTextManifest({ id: 'x', versions: [{ chapters_total: 1 }] }, 'x').some((f) => f.code === 'manifest.version-key'));
    assert.ok(checkTextManifest({ id: 'x', versions: [{ key: 'a', chapters_total: '1' }] }, 'x').some((f) => f.code === 'manifest.chapters_total' && f.severity === 'warn'));
    assert.ok(checkTextManifest({ id: 'x', versions: [{ key: 'a', chapters_total: -3 }] }, 'x').some((f) => f.code === 'manifest.chapters_total' && f.severity === 'warn'), '负数不行');
    assert.deepEqual(checkTextManifest({ id: 'x', versions: [{ key: 'a', chapters_total: 0 }] }, 'x'), [], '0 可以');
});

test('meta-home：counts 与 meta 必须一致', () => {
    const meta = load('old/meta.json');
    const ok = { counts: { works: meta.works, books: meta.books, collections: meta.collections, entities: meta.entities } };
    assert.deepEqual(checkMetaHome(ok, meta), []);
    assert.ok(checkMetaHome({ counts: { ...ok.counts, works: 1 } }, meta).some((f) => f.code === 'meta-home.counts-mismatch'));
    assert.ok(checkMetaHome({}, meta).some((f) => f.code === 'meta-home.counts'));
});
