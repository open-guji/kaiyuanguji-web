import { COMPARE_PREFS_KEY, DEFAULT_COMPARE_PREFS, loadComparePrefs, parseComparePrefs, saveComparePrefs } from '../prefs';

describe('对校设置', () => {
    beforeEach(() => window.localStorage.clear());

    it('默认不显示异体字与题名，显示用字不同与增减', () => {
        expect(DEFAULT_COMPARE_PREFS.cats).toMatchObject({ word: true, add: true, omit: true, glyph: false, struct: false });
        expect(loadComparePrefs()).toEqual(DEFAULT_COMPARE_PREFS);
    });

    it('存下来后能读回（位置记忆）', () => {
        saveComparePrefs({ cats: { ...DEFAULT_COMPARE_PREFS.cats, glyph: true }, mode: 'simple' });
        expect(loadComparePrefs()).toMatchObject({ cats: { glyph: true }, mode: 'simple' });
    });

    it('坏数据退回默认，未知字段不影响', () => {
        expect(parseComparePrefs('{坏')).toEqual(DEFAULT_COMPARE_PREFS);
        expect(parseComparePrefs(JSON.stringify({ cats: { glyph: 'yes', word: false }, mode: 'x' }))).toEqual({
            cats: { ...DEFAULT_COMPARE_PREFS.cats, word: false },
            mode: 'sub',
        });
    });

    it('localStorage 不可用时不抛错', () => {
        const spy = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
        expect(() => saveComparePrefs(DEFAULT_COMPARE_PREFS)).not.toThrow();
        spy.mockRestore();
        expect(window.localStorage.getItem(COMPARE_PREFS_KEY)).toBeNull();
    });
});
