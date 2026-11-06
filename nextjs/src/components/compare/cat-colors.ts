import type { DiffCat } from '@/lib/compare/classify';

/** 类别色：只用颜色区分（不加符号）。变量在 globals.css 的 `.cmp-vars` 里按明暗主题定义；这里给组件用的引用 */
export const CAT_COLOR: Record<DiffCat, string> = {
    glyph: 'var(--cmp-glyph)',
    word: 'var(--cmp-word)',
    add: 'var(--cmp-add)',
    omit: 'var(--cmp-omit)',
    struct: 'var(--cmp-struct)',
};
