/**
 * 对读章的生僻字子集字体（GUJI-701）。
 *
 * 数据打包给对读章生成 <章>.font.woff2（约 10KB），章条目记 `font_file`、`font_range`（scripts/lib/chapter-fonts.mjs）。
 * 页面追加同字族的 @font-face（HanaMinA、HanaMinB 各一条，同一地址只下一次）：同字族 unicode-range 重叠时后定义的先查，
 * 这些字就从子集取，不再去下 globals.css 里花园明朝的大分片；子集取不到时照旧回落分片。
 * 首屏那一章由服务端渲染直接出（page.ssr.tsx）；站内换章不经服务端，由阅读器在取新章数据时调 ensureChapterFont 补上。
 */

const FONT_RANGE_RE = /^U\+[0-9A-F]{4,6}(?:-[0-9A-F]{4,6})?(?:,U\+[0-9A-F]{4,6}(?:-[0-9A-F]{4,6})?)*$/;

/** 章条目里合规的 font_file／font_range；不合规（或没有）返回 null */
export function chapterFontMeta(chapter: Record<string, unknown> | null | undefined): { file: string; range: string } | null {
    const file = chapter?.font_file;
    const range = chapter?.font_range;
    if (typeof file !== 'string' || !/^[\w.-]+\.woff2$/.test(file)) return null;
    if (typeof range !== 'string' || range.length > 50_000 || !FONT_RANGE_RE.test(range)) return null;
    return { file, range };
}

/** 地址要原样放进 CSS 的 url("…")：带引号、括号、反斜杠、空白的不用 */
export function isCssSafeUrl(href: string | null | undefined): href is string {
    return !!href && !/["'()\\\s]/.test(href);
}

export function chapterFontCss({ href, range }: { href: string; range: string }): string {
    return ['HanaMinA', 'HanaMinB']
        .map((f) => `@font-face{font-family:"${f}";font-style:normal;font-weight:400;font-display:swap;src:url("${href}") format("woff2");unicode-range:${range}}`)
        .join('');
}

interface FontUrlStorage {
    getTextFileUrl?: (id: string, key: string, file: string) => Promise<string | null>;
}

/**
 * 站内换章：给这一章补上子集字体的 @font-face（加在 body 末尾，排在 globals.css 之后＝后定义）。
 * 已有同一地址的（服务端渲染出的首屏那一条、或之前换到过这一章）不再加；数据源给不出地址（h1 布局）就不加。
 */
export async function ensureChapterFont(storage: object | undefined, id: string, key: string, chapter: Record<string, unknown> | null | undefined): Promise<void> {
    if (typeof document === 'undefined') return;
    const meta = chapterFontMeta(chapter);
    const getUrl = (storage as FontUrlStorage | undefined)?.getTextFileUrl;
    if (!meta || typeof getUrl !== 'function') return;
    const href = await getUrl.call(storage, id, key, meta.file).catch(() => null);
    if (!isCssSafeUrl(href)) return;
    const existing = document.querySelectorAll('style#kyg-chapter-font, style[data-kyg-chapter-font]');
    for (const el of existing) if (el.textContent?.includes(`url("${href}")`)) return;
    const el = document.createElement('style');
    el.setAttribute('data-kyg-chapter-font', meta.file);
    el.textContent = chapterFontCss({ href, range: meta.range });
    document.body.appendChild(el);
}
