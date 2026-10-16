import { parseProof, proofPage, isDoubtful, isMissingChar, isHumanChecked, loadProofLayer } from '../proof';

// 形状照 Mila 在 #605 给的样张（guji-proof/0.1）：每格 id/a/c/method/review/channel/cand
const MOCK = {
    schema: 'guji-proof/0.1',
    cells: [
        { id: 'g1', a: '1:1:1', c: '洪', method: 'cv:glyph', review: 'auto', channel: 'iron', cand: ['洪', '烘'] },
        { id: 'g2', a: '1:1:2', c: '范', method: 'cv:pending', review: 'pending' },
        { id: 'g3', a: '1:2:21a', c: '傳', method: 'human', review: 'human' },
        { id: 'g4', a: '1:2:21b', c: '□', method: 'cv:occluded_default', review: 'pending' },
        { id: 'g5', a: '2:1:1', c: '書', method: 'cv:new_channel', review: 'disputed' },
        { id: 'g6', a: '-1', c: '？', method: 'cv:pending', review: 'pending' },
        { id: 'g7', a: 'x:y', review: 'auto' },
        { id: 'g8', method: 'human', review: 'human' },
        null,
        'bad',
    ],
};

describe('parseProof', () => {
    it('按 a 建索引，忽略 a=-1／坐标形态不对／缺 a 的条目', () => {
        const l = parseProof(MOCK);
        expect([...l.cells.keys()]).toEqual(['1:1:1', '1:1:2', '1:2:21a', '1:2:21b', '2:1:1']);
    });
    it('未知 review 一律按 pending（偏安全）；method 原样保留不做枚举', () => {
        const l = parseProof(MOCK);
        expect(l.cells.get('2:1:1')).toMatchObject({ review: 'pending', method: 'cv:new_channel' });
        expect(l.cells.get('1:1:1')).toMatchObject({ review: 'auto', method: 'cv:glyph', channel: 'iron', cand: [{ c: '洪' }, { c: '烘' }] });
    });
    it('cand 读 CV 导出的对象形：保留来源键，同字合并来源，不要求有 c', () => {
        const l = parseProof({ cells: [{ a: '1:1:1', cand: { lib: '洪', ocr: '洪', rare: '烘', ref: '' } }, { a: '1:1:2', cand: { x_new: '浩' } }] });
        expect(l.cells.get('1:1:1')?.cand).toEqual([{ c: '洪', src: ['lib', 'ocr'] }, { c: '烘', src: ['rare'] }]);
        expect(l.cells.get('1:1:1')?.c).toBeUndefined();
        expect(l.cells.get('1:1:2')?.cand).toEqual([{ c: '浩', src: ['x_new'] }]);
        expect(parseProof({ cells: [{ a: '1:1:3', cand: {} }, { a: '1:1:4', cand: 'x' }] }).cells.get('1:1:3')).toEqual({ a: '1:1:3', method: '', review: 'pending' });
    });
    it('缺字段不抛：method 缺则为空串，cand 缺则无该字段', () => {
        const l = parseProof({ cells: [{ a: '3:1:1' }] });
        expect(l.cells.get('3:1:1')).toEqual({ a: '3:1:1', method: '', review: 'pending' });
    });
    it('裸数组也认；整体形状不对、null、坏输入返回空层且不抛', () => {
        expect(parseProof([{ a: '1:1:1', review: 'human', method: 'human' }]).cells.size).toBe(1);
        for (const bad of [null, undefined, 42, 'x', {}, { cells: 'x' }]) expect(parseProof(bad).cells.size).toBe(0);
    });
    it('重复的 a 后者覆盖前者，页索引不重复', () => {
        const l = parseProof({ cells: [{ a: '1:1:1', review: 'auto' }, { a: '1:1:1', review: 'human' }] });
        expect(l.cells.get('1:1:1')?.review).toBe('human');
        expect(l.pages.get(1)).toEqual(['1:1:1']);
    });
});

describe('proofPage', () => {
    it('按页序取该页的格，保持输入顺序；没有的页返回空数组', () => {
        const l = parseProof(MOCK);
        expect(proofPage(l, 1).map(c => c.a)).toEqual(['1:1:1', '1:1:2', '1:2:21a', '1:2:21b']);
        expect(proofPage(l, 2).map(c => c.a)).toEqual(['2:1:1']);
        expect(proofPage(l, 9)).toEqual([]);
    });
});

describe('展示分类', () => {
    const l = parseProof(MOCK);
    it('存疑＝pending 且不是缺字；缺字单独标；只有 human 算人工校过', () => {
        expect(isDoubtful(l.cells.get('1:1:2')!)).toBe(true);
        expect(isDoubtful(l.cells.get('1:2:21b')!)).toBe(false);
        expect(isMissingChar(l.cells.get('1:2:21b')!)).toBe(true);
        expect(isHumanChecked(l.cells.get('1:2:21a')!)).toBe(true);
        expect(isHumanChecked(l.cells.get('1:1:1')!)).toBe(false); // auto 不能写成已校
    });
});

describe('loadProofLayer', () => {
    const ctx = { versionKey: 'v1', chapter: { proof_file: '001.proof.json' } };
    it('按 proof_file 取数，用 storage.getTextFile', async () => {
        const getTextFile = jest.fn().mockResolvedValue(MOCK);
        const l = await loadProofLayer('bk-load-1', ctx, { getTextFile });
        expect(getTextFile).toHaveBeenCalledWith('bk-load-1', 'v1', '001.proof.json');
        expect(l.cells.size).toBe(5);
    });
    it('未声明 proof_file、文件名带路径、没有版本 key：返回空层，不发请求', async () => {
        const getTextFile = jest.fn();
        for (const c of [
            { versionKey: 'v1', chapter: {} },
            { versionKey: 'v1', chapter: { proof_file: '../x.json' } },
            { versionKey: null, chapter: { proof_file: '001.proof.json' } },
            undefined,
        ]) expect((await loadProofLayer('bk-load-2', c, { getTextFile })).cells.size).toBe(0);
        expect(getTextFile).not.toHaveBeenCalled();
    });
    it('取数抛错：返回空层且不缓存，下次重取', async () => {
        const getTextFile = jest.fn().mockRejectedValueOnce(new Error('net')).mockResolvedValueOnce(MOCK);
        expect((await loadProofLayer('bk-load-3', ctx, { getTextFile })).cells.size).toBe(0);
        await Promise.resolve();
        expect((await loadProofLayer('bk-load-3', ctx, { getTextFile })).cells.size).toBe(5);
        expect(getTextFile).toHaveBeenCalledTimes(2);
    });
});
