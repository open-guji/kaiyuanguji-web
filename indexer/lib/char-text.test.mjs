import test from 'node:test';
import assert from 'node:assert/strict';
import { CHAR_FILE_RE, charJsonText } from './char-text.mjs';

const cell = (a, c, extra = {}) => ({ a, c, ...extra });

test('按数组顺序拼各列的字，跳过版心／空白列和阙文格', () => {
    const raw = {
        pages: [
            { page: 1, columns: [
                { col: 1, cells: [cell('1:1:1', '甲'), cell('1:1:2', '乙'), cell('1:1:3', '□', { lacuna: true })] },
                { col: 2, kind: 'banxin', cells: [cell('1:2:1', '版')] },
                { col: 3, kind: 'blank', cells: [] },
                { col: 4, cells: [cell('1:4:1', '丙', { lane: 'jz_r' }), cell('1:4:2', '丁', { lane: 'jz_l' })] },
            ] },
            { page: 2, columns: [{ col: 1, cells: [cell('2:1:1', '戊')] }] },
        ],
    };
    assert.equal(charJsonText(raw), '甲乙丙丁戊');
});

test('图片格（带 fig）与图列（kind: figure）不进索引文本：搜「圖作形」命中「圖作▢形」（GUJI-737）', () => {
    const raw = {
        pages: [
            { page: 148, columns: [
                { col: 2, cells: [cell('148:2:12', '圖'), cell('148:2:13', '作'), cell('148:2:14', '□', { fig: 'f148-2-14' }), cell('148:2:15', '形')] },
            ] },
            { page: 149, columns: [
                { col: 1, cells: [cell('149:1:1', '河')] },
                { col: 2, kind: 'figure', span: 4, fig: 'p149-fig1', cells: [] },
                { col: 6, cells: [cell('149:6:1', '洛')] },
            ] },
        ],
    };
    assert.equal(charJsonText(raw), '圖作形河洛');
});

test('结构不对或没有字：空串', () => {
    assert.equal(charJsonText(null), '');
    assert.equal(charJsonText({}), '');
    assert.equal(charJsonText({ pages: [{ columns: [{ cells: [{ a: 'x' }, null, { c: 3 }, { c: '' }] }] }] }), '');
});

test('char 文件名只收 NNN.char.json 形式', () => {
    assert.ok(CHAR_FILE_RE.test('002.char.json'));
    assert.ok(!CHAR_FILE_RE.test('../002.char.json'));
    assert.ok(!CHAR_FILE_RE.test('002.json'));
});
