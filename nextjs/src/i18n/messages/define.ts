/**
 * 网站自己的界面文字字典（overview#337）。写法与 book-index-ui 的 src/i18n/messages 一致：
 *
 *     export const footer = defineMessages({
 *         about: '關於',
 *         copyright: '© {year} 開源古籍',
 *     }, {
 *         about: '关于',
 *         copyright: '© {year} 开源古籍',
 *     });
 *
 * - 第一栏繁体、第二栏简体，键必须一一对应（少键、多键 tsc 报错）；第三栏留给英文，可只写一部分，缺的回落繁体。
 * - 插值写 {name}，t('footer.copyright', { year: 2026 })。
 * - 本目录不引 book-index-ui、不引 opencc：顶栏、首页等静态页也用它，不能被拖大。
 */

/** 把字面量类型放宽成 string，用来约束简体／英文栏与繁体同形 */
export type Shape<T> = { [K in keyof T]: T[K] extends string ? string : Shape<T[K]> };

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends string ? string : DeepPartial<T[K]> };

export interface MessageSet<T> {
    'zh-Hant': T;
    'zh-Hans': Shape<T>;
    en?: DeepPartial<T>;
}

export function defineMessages<T extends Record<string, unknown>>(
    hant: T,
    hans: NoInfer<Shape<T>>,
    en?: NoInfer<DeepPartial<T>>,
): MessageSet<Shape<T>> {
    return { 'zh-Hant': hant as Shape<T>, 'zh-Hans': hans, ...(en ? { en } : {}) } as MessageSet<Shape<T>>;
}
