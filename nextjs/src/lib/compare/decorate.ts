/**
 * 差异条目 → 按格位的修饰（阅读器插件接口 `decorate` 的返回；类型照长期方案 §4.2 草案，P 线定稿后对一下）。
 * 只用颜色区分类别，对照字放下标，不加符号。
 */
import type { CompareItem } from './compare';
import type { DiffCat } from './classify';
import type { ComparePrefs } from './prefs';
import type { BaseCell } from './volumes';

export interface CellDecoration {
    /** 自定义字色（任意 CSS 颜色，可写 var(--x)）；底线颜色跟字色 */
    fg?: string;
    underline?: 'solid' | 'dotted' | 'wavy' | 'dashed';
    /** 下标小字：对照本的写法 */
    sub?: string;
    /** 字后插入的小字：对照本多出的字 */
    insertAfter?: string;
    title?: string;
    focus?: boolean;
}

/** 类别 → 字色（token）与底线样式。add 的字色不给：增字挂在底本前一字后，那个底本字本身没有差异 */
export const CAT_STYLE: Record<DiffCat, { fg?: string; underline: CellDecoration['underline'] }> = {
    glyph: { fg: 'var(--cmp-glyph)', underline: 'dotted' },
    word: { fg: 'var(--cmp-word)', underline: 'solid' },
    add: { underline: 'solid' },
    omit: { fg: 'var(--cmp-omit)', underline: 'dashed' },
    struct: { fg: 'var(--cmp-struct)', underline: 'dashed' },
};

export const CAT_NAME: Record<DiffCat, string> = {
    glyph: '異體字',
    word: '用字不同',
    add: '對照本多',
    omit: '對照本少',
    struct: '題名／版式',
};

/** 当前设置下要显示的条目 */
export const visibleItems = (items: readonly CompareItem[], prefs: ComparePrefs): CompareItem[] => items.filter((i) => prefs.cats[i.cat]);

/**
 * 修饰表：底本被替换／被删的每个字带底线（add 没有底本字，把「对照本多出」挂在插入点前一字的字后）；
 * 对照写法（sub）放在这一处最后一个底本字上；简洁模式不出下标，只留底线。
 * 同一格被多处覆盖时（只有 add 的插入点会与别处重叠）以非 add 为准，insertAfter 另并入。
 */
export function buildDecorations(items: readonly CompareItem[], cells: readonly BaseCell[], prefs: ComparePrefs, focusId?: string | null): Map<string, CellDecoration> {
    const map = new Map<string, CellDecoration>();
    const put = (i: number, d: CellDecoration) => {
        const a = cells[i]?.a;
        if (a === undefined) return;
        map.set(a, { ...map.get(a), ...d });
    };
    for (const it of visibleItems(items, prefs)) {
        const st = CAT_STYLE[it.cat];
        const focus = it.id === focusId ? { focus: true } : {};
        if (it.type === 'ins') {
            // 底本这个字本身没有差异：只挂「字后插入」（简洁模式没有下标，改成给它画一条底线表示此处有增字）
            const sub = prefs.mode === 'sub';
            put(it.i1 - 1, { ...(sub ? { insertAfter: it.reading } : { underline: st.underline }), title: `${CAT_NAME[it.cat]}：${it.reading}`, ...focus });
            continue;
        }
        for (let i = it.i1; i < it.i2; i++) {
            const last = i === it.i2 - 1;
            put(i, {
                fg: st.fg,
                underline: st.underline,
                ...(last && prefs.mode === 'sub' && it.type === 'sub' ? { sub: it.reading } : {}),
                title: it.type === 'del' ? `${CAT_NAME[it.cat]}（對照本無此字）` : `${CAT_NAME[it.cat]}：${it.reading}`,
                ...focus,
            });
        }
    }
    return map;
}

/** 各类别条数（不受显示开关影响，设置栏上显示总数） */
export function countByCat(items: readonly CompareItem[]): Record<DiffCat, number> {
    const n: Record<DiffCat, number> = { glyph: 0, word: 0, add: 0, omit: 0, struct: 0 };
    for (const i of items) n[i.cat]++;
    return n;
}

/** 格位 → 覆盖它的条目（点击某字找差异）：ins 登在插入点前一字上 */
export function itemByAnchor(items: readonly CompareItem[], cells: readonly BaseCell[]): Map<string, CompareItem> {
    const m = new Map<string, CompareItem>();
    for (const it of items) {
        if (it.type === 'ins') {
            const a = cells[it.i1 - 1]?.a;
            if (a !== undefined && !m.has(a)) m.set(a, it);
            continue;
        }
        for (let i = it.i1; i < it.i2; i++) {
            const a = cells[i]?.a;
            if (a !== undefined) m.set(a, it);
        }
    }
    return m;
}

/** 上一处／下一处：在当前显示的条目里按底本字序找，到头回到另一端 */
export function stepItem(shown: readonly CompareItem[], currentId: string | null, dir: 1 | -1): CompareItem | null {
    if (shown.length === 0) return null;
    const k = shown.findIndex((i) => i.id === currentId);
    if (k < 0) return dir === 1 ? shown[0] : shown[shown.length - 1];
    return shown[(k + dir + shown.length) % shown.length];
}
