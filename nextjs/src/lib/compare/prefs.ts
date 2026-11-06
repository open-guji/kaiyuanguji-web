/**
 * 对校设置（存本机，和专名线、标点同一类；不进地址）：显示哪几类差异、下标显示还是简洁。
 * 默认（也是分享链接打开的人看到的）：用字不同＋增减，异体字与题名关。
 */
import type { DiffCat } from './classify';

export interface ComparePrefs {
    cats: Record<DiffCat, boolean>;
    /** sub＝对照本的写法放下标；simple＝只留底线 */
    mode: 'sub' | 'simple';
}

export const DEFAULT_COMPARE_PREFS: ComparePrefs = {
    cats: { word: true, add: true, omit: true, glyph: false, struct: false },
    mode: 'sub',
};

export const COMPARE_PREFS_KEY = 'guji.compare.prefs';

export function parseComparePrefs(raw: string | null): ComparePrefs {
    if (!raw) return DEFAULT_COMPARE_PREFS;
    try {
        const v = JSON.parse(raw) as Partial<ComparePrefs>;
        const cats = { ...DEFAULT_COMPARE_PREFS.cats };
        for (const k of Object.keys(cats) as DiffCat[]) if (typeof v.cats?.[k] === 'boolean') cats[k] = v.cats[k];
        return { cats, mode: v.mode === 'simple' ? 'simple' : 'sub' };
    } catch {
        return DEFAULT_COMPARE_PREFS;
    }
}

export function loadComparePrefs(): ComparePrefs {
    try {
        return parseComparePrefs(window.localStorage.getItem(COMPARE_PREFS_KEY));
    } catch {
        return DEFAULT_COMPARE_PREFS;
    }
}

export function saveComparePrefs(p: ComparePrefs): void {
    try {
        window.localStorage.setItem(COMPARE_PREFS_KEY, JSON.stringify(p));
    } catch {
        /* 无痕等不可写：本次有效即可 */
    }
}
