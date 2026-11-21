import test from 'node:test';
import assert from 'node:assert/strict';
import { grams, headTokens, docToRow } from '../pg-rows.mjs';

test('grams：单字＋相邻二字，拉丁整词，扩展区汉字不被劈开', () => {
    assert.deepEqual(grams('三國志').sort(), ['三', '三國', '國', '國志', '志'].sort());
    assert.deepEqual(grams('Sanguo 12'), ['sanguo', '12']);
    assert.ok(grams('𠂇孟').includes('𠂇孟'));
});

test('docToRow：works', () => {
    const r = docToRow('works', { id: 'w1', type: 'work', title: '史記', author: '司馬遷', dynasty: '漢', classification: '', has_text: true,
        completeness: 9, title_search: '史記 史记', author_search: '司馬遷', title_sort: 'shi ji', description_search: '紀傳體通史', juan_count: 130 });
    assert.equal(r.kind, 'work');
    assert.equal(r.classification, null);
    assert.equal(r.title_chars, 2);
    assert.ok(r.title_tok.includes('史記') && r.title_tok.includes('shi'));
    assert.ok(r.name_tok.includes('司馬') && !r.name_tok.includes('紀傳'));
    assert.ok(r.desc_tok.includes('紀傳'));
    assert.deepEqual(r.payload, { juan_count: 130 });
    assert.equal(r.descr, '紀傳體通史');
});

test('docToRow：人物用 primary_name／name_search；office_ids 转文本', () => {
    const r = docToRow('entities', { id: 'e1', type: 'entity', primary_name: '李白', name_search: '李白 太白', office_ids: [3, 5], birth_year: 701 });
    assert.equal(r.title, '李白');
    assert.deepEqual(r.office_ids, ['3', '5']);
    assert.ok(r.title_tok.includes('李白'));
    assert.deepEqual(r.payload, { birth_year: 701 });
});

test('docToRow：缺 id 或未知索引报错', () => {
    assert.throws(() => docToRow('works', {}));
    assert.throws(() => docToRow('juans', { id: 'x' }));
});

test('headTokens：繁简各取前 1／2 字，拉丁词不取', () => {
    assert.deepEqual(headTokens('史記 史记').sort(), ['^史', '^史記', '^史记'].sort());
    assert.deepEqual(headTokens('三'), ['^三']);
    assert.deepEqual(headTokens('shi ji'), []);
});
test('docToRow：title_tok 带开头词元', () => {
    const r = docToRow('works', { id: 'w', title: '史記', title_search: '史記 史记' });
    assert.ok(r.title_tok.includes('^史記') && r.title_tok.includes('史記'));
});
