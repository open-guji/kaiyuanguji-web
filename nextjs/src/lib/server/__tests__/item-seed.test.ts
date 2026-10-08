import { INITIAL_DETAIL_MAX_BYTES, seedForItem } from '../item-seed';

describe('seedForItem：条目页内嵌 initialDetail 的体积上限', () => {
    it('小条目原样返回', () => {
        const e = { id: 'a', title: '論語集注' };
        expect(seedForItem(e)).toBe(e);
    });

    it('按 UTF-8 字节算，不按字符数：汉字 3 字节', () => {
        // 16,000 个汉字＝48,000 字节＋JSON 外壳，超限；字符数只有 16,000
        const e = { id: 'a', text: '史'.repeat(16_000) };
        expect(JSON.stringify(e).length).toBeLessThan(INITIAL_DETAIL_MAX_BYTES);
        expect(seedForItem(e)).toBeUndefined();
    });

    it('恰在上限内仍返回', () => {
        const shell = Buffer.byteLength(JSON.stringify({ t: '' }), 'utf8');
        const e = { t: 'a'.repeat(INITIAL_DETAIL_MAX_BYTES - shell) };
        expect(Buffer.byteLength(JSON.stringify(e), 'utf8')).toBe(INITIAL_DETAIL_MAX_BYTES);
        expect(seedForItem(e)).toBe(e);
        expect(seedForItem({ t: e.t + 'a' })).toBeUndefined();
    });
});
