/**
 * lite.js：L2 轻量分片的编码与线性扫描检索（S1）
 */
import { encodeLiteRow, decodeLiteRows, liteSearch } from '../lite.js';

describe('encodeLiteRow', () => {
    it('末尾空字段省略；简体与原文相同时不写', () => {
        expect(encodeLiteRow({ id: 'a', title: '易', author: '', dynasty: '' })).toEqual(['a', '易']);
        expect(encodeLiteRow({ id: 'b', title: '論語', author: '孔子', titleS: '论语', authorS: '孔子' }))
            .toEqual(['b', '論語', '孔子', '', '论语']);
        expect(encodeLiteRow({ id: 'c', title: '易', author: '', dynasty: '', titleS: '易', authorS: '' }))
            .toEqual(['c', '易']);
    });

    it('编码 → 解码往返', () => {
        const rows = [encodeLiteRow({ id: 'w1', title: '史記', author: '司馬遷', dynasty: '西漢', titleS: '史记', authorS: '司马迁' })];
        const [d] = decodeLiteRows(JSON.parse(JSON.stringify(rows)), 'work');
        expect(d).toMatchObject({ id: 'w1', type: 'work', title: '史記', author: '司馬遷', dynasty: '西漢' });
    });

    it('坏行跳过', () => {
        expect(decodeLiteRows([null, 3, ['x', 'ok'], [1, 'bad']], 'book').map(d => d.id)).toEqual(['x']);
    });
});

describe('liteSearch', () => {
    const docs = decodeLiteRows([
        ['w9', '史記索隱', '司馬貞', '唐', '史记索隐', '司马贞'],
        ['w1', '史記', '司馬遷', '西漢', '史记', '司马迁'],
        ['w2', '史記', '徐堅', '唐', '史记', '徐坚'],
        ['w3', '孟子正義', '焦循', '清', '孟子正义'],
        ['w4', 'Tao Te Ching', 'Laozi'],
    ], 'work');
    const ids = (q: string) => liteSearch(docs, q).map(h => h.doc.id);

    it('书名完全相同 > 前缀；同分按行序（构建期已按资料丰富度排）', () => {
        expect(ids('史記')).toEqual(['w1', 'w2', 'w9']);
    });

    it('简体查询命中繁体书名', () => {
        expect(ids('史记索隐')).toEqual(['w9']);
        expect(ids('孟子正义')).toEqual(['w3']);
    });

    it('作者命中；多词须都命中（书名或作者）', () => {
        expect(ids('司马迁')).toEqual(['w1']);
        expect(ids('史記 徐堅')).toEqual(['w2']);
        // 没有同时命中两词的：落到投票兜底，两边各自的命中都给出
        expect(ids('史記 焦循')).toEqual(expect.arrayContaining(['w1', 'w3']));
    });

    it('大小写与标点不敏感', () => {
        expect(ids('tao te ching')).toEqual(['w4']);
        expect(ids('《孟子正義》')).toEqual(['w3']);
    });

    it('严格 0 命中且 ≥3 字：按 bigram 投票兜底（先过半，再逐层放宽）', () => {
        // 「孟子正解」：bigrams 孟子/子正/正解，命中 2/3 ≥ 2
        expect(ids('孟子正解')).toEqual(['w3']);
        // 放宽到 1 个 bigram：「孟子梁惠王」只有「孟子」命中也给结果
        expect(ids('孟子梁惠王')).toEqual(['w3']);
        // 两字查询不走投票
        expect(ids('孟解')).toEqual([]);
    });

    it('空查询返回空', () => {
        expect(ids('   ')).toEqual([]);
    });
});
