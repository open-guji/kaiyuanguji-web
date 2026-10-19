import { juanToChinese, summarizeItem } from '../item-summary';

describe('juanToChinese', () => {
    it('万以内', () => {
        expect(juanToChinese(10)).toBe('十');
        expect(juanToChinese(105)).toBe('一百〇五');
        expect(juanToChinese(2416)).toBe('二千四百一十六');
    });
    it('万以上（永樂大典）', () => {
        expect(juanToChinese(22877)).toBe('二萬二千八百七十七');
        expect(juanToChinese(20828)).toBe('二萬〇八百二十八');
        expect(juanToChinese(10000)).toBe('一萬');
    });
});

describe('summarizeItem measure 兜底', () => {
    it('measure_info 优先', () => {
        expect(summarizeItem({ type: 'work', measure_info: '十卷', juan_count: { number: 10 } } as never, 'x').measure).toBe('十卷');
    });
    it('juan_count 兜底转汉字并读 unit', () => {
        expect(summarizeItem({ type: 'work', juan_count: { number: 18, unit: '篇' } } as never, 'x').measure).toBe('十八篇');
        expect(summarizeItem({ type: 'work', juan_count: 22877 } as never, 'x').measure).toBe('二萬二千八百七十七卷');
    });
});
