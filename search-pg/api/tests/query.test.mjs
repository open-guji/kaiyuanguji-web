import test from 'node:test';
import assert from 'node:assert/strict';
import { toCall, descriptionSnippet, shapeResult, BadRequest, MARK_START, MARK_END } from '../lib/query.mjs';

test('toCall：筛选映射成 search_one 参数', () => {
    const c = toCall({
        indexUid: 'works', q: ' 史記 ', limit: 20, offset: 40,
        filter: [
            { field: 'dynasty', op: 'in', values: ['唐', '宋'] },
            { field: 'classification', op: 'eq', values: [''] },
            { field: 'has_image', op: 'eq', values: [true] },
        ],
        sort: 'era_rank:asc',
    });
    assert.equal(c.empty, false);
    assert.deepEqual(c.args, ['work', '史記', 20, 40, ['唐', '宋'], [''], null, null, true, null, null, 'era:asc']);
});

test('toCall：type 与索引矛盾 → empty；与索引一致 → 不筛', () => {
    assert.equal(toCall({ indexUid: 'works', q: 'a', filter: [{ field: 'type', op: 'eq', values: ['book'] }] }).empty, true);
    assert.equal(toCall({ indexUid: 'works', q: 'a', filter: [{ field: 'type', op: 'eq', values: ['work'] }] }).empty, false);
});

test('toCall：越权字段、重复字段、坏排序、坏索引一律 400', () => {
    const bad = [
        { indexUid: 'books', q: 'a', filter: [{ field: 'classification', op: 'eq', values: ['史部'] }] },
        { indexUid: 'works', q: 'a', filter: [{ field: 'is_draft', op: 'eq', values: [false] }] },
        { indexUid: 'works', q: 'a', filter: [{ field: 'dynasty', op: 'eq', values: ['唐'] }, { field: 'dynasty', op: 'eq', values: ['宋'] }] },
        { indexUid: 'collections', q: 'a', sort: 'era_rank:asc' },
        { indexUid: 'works', q: 'a', sort: 'title; drop table' },
        { indexUid: 'tasks', q: 'a' },
        { indexUid: 'works' },
    ];
    for (const b of bad) assert.throws(() => toCall(b), BadRequest);
});

test('toCall：limit／offset 夹到上限', () => {
    const c = toCall({ indexUid: 'works', q: 'a', limit: 999, offset: 99999 });
    assert.equal(c.limit, 50);
    assert.equal(c.offset, 1000);
});

test('descriptionSnippet：整段词命中、加标记、窗口裁到 80 字上下', () => {
    const descr = `${'前'.repeat(100)}漢趙岐注孟子十四卷${'後'.repeat(100)}`;
    const s = descriptionSnippet(descr, '孟子');
    assert.ok(s.includes(`${MARK_START}孟子${MARK_END}`));
    assert.ok(s.startsWith('…') && s.endsWith('…'));
    assert.ok(Array.from(s.replaceAll('…', '').replaceAll(MARK_START, '').replaceAll(MARK_END, '')).length <= 80);
});

test('descriptionSnippet：整段找不到时退到相邻二字；都没有就不返回', () => {
    const s = descriptionSnippet('孟子十四卷，趙岐注。', '孟子趙岐');
    assert.ok(s.includes(`${MARK_START}孟子${MARK_END}`) && s.includes(`${MARK_START}趙岐${MARK_END}`));
    assert.equal(descriptionSnippet('毫不相干的文字', '孟子'), undefined);
});

test('descriptionSnippet：不劈开扩展区汉字', () => {
    const descr = `${'前'.repeat(29)}𠂇${'後'.repeat(10)}孟子${'後'.repeat(80)}`;
    const s = descriptionSnippet(descr, '𠂇');
    assert.ok(s.includes(`${MARK_START}𠂇${MARK_END}`));
    assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s));
});

test('shapeResult：_descr 换成 _formatted，没命中就没有', () => {
    const call = { indexUid: 'works', q: '孟子', limit: 5, offset: 0 };
    const r = shapeResult(call, { estimatedTotalHits: 2, hits: [{ id: 'a', _descr: '孟子注' }, { id: 'b', _descr: '無關' }, { id: 'c' }] }, 3);
    assert.ok(r.hits[0]._formatted.description_search.includes(MARK_START));
    assert.equal(r.hits[1]._formatted, undefined);
    assert.ok(!('_descr' in r.hits[0]) && !('_descr' in r.hits[1]));
    assert.equal(r.estimatedTotalHits, 2);
});

test('shapeResult：人物卡片 title → primary_name', () => {
    const call = { indexUid: 'entities', q: '李白', limit: 5, offset: 0 };
    const r = shapeResult(call, { hits: [{ id: 'e1', type: 'entity', title: '李白', dynasty: '唐' }] }, 1);
    assert.deepEqual(r.hits[0], { id: 'e1', type: 'entity', primary_name: '李白', dynasty: '唐' });
});
