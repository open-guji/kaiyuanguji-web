/**
 * 章的生僻字子集字体（GUJI-701 对读章起；GUJI-721 推到全部章，字源 Jigmo 2025.9.12，含扩 G–J）。
 *
 * 数据打包给每个有生僻字的章生成 <章>.font.woff2（中位约 5KB），章条目记 `font_file`、`font_range`；
 * 生僻字超过 256 个的章切块，第 2 块起记在 `font_parts: [{ file, range }]`（scripts/lib/chapter-fonts.mjs）。
 * 页面每块追加同字族的 @font-face（HanaMinA、HanaMinB 各一条，同一地址只下一次）：同字族 unicode-range 重叠时后定义的先查，
 * 这些字就从子集取，不再去下 globals.css 里花园明朝的大分片；子集取不到时照旧回落分片。扩 G–J 花园明朝没有，只有子集里有。
 * 首屏那一章由服务端渲染直接出（page.ssr.tsx）；站内换章不经服务端，由阅读器在取新章数据时调 ensureChapterFont 补上。
 */

const FONT_RANGE_RE = /^U\+[0-9A-F]{4,6}(?:-[0-9A-F]{4,6})?(?:,U\+[0-9A-F]{4,6}(?:-[0-9A-F]{4,6})?)*$/;

export interface ChapterFontPart { file: string; range: string }

function fontPart(file: unknown, range: unknown): ChapterFontPart | null {
    if (typeof file !== 'string' || !/^[\w.-]+\.woff2$/.test(file)) return null;
    if (typeof range !== 'string' || range.length > 50_000 || !FONT_RANGE_RE.test(range)) return null;
    return { file, range };
}

/** 章条目里合规的子集块：第 1 块是 font_file／font_range，后面是 font_parts 里合规的；第 1 块不合规（或没有）返回 null */
export function chapterFontMeta(chapter: Record<string, unknown> | null | undefined): ChapterFontPart[] | null {
    const first = fontPart(chapter?.font_file, chapter?.font_range);
    if (!first) return null;
    const more = Array.isArray(chapter?.font_parts) ? chapter.font_parts : [];
    const rest = more.slice(0, 16).map((p) => fontPart((p as Record<string, unknown> | null)?.file, (p as Record<string, unknown> | null)?.range));
    return [first, ...rest.filter((p): p is ChapterFontPart => !!p)];
}

/** 地址要原样放进 CSS 的 url("…")：带引号、括号、反斜杠、空白的不用 */
export function isCssSafeUrl(href: string | null | undefined): href is string {
    return !!href && !/["'()\\\s]/.test(href);
}

export function chapterFontCss(parts: { href: string; range: string } | { href: string; range: string }[]): string {
    return (Array.isArray(parts) ? parts : [parts]).flatMap(({ href, range }) => ['HanaMinA', 'HanaMinB']
        .map((f) => `@font-face{font-family:"${f}";font-style:normal;font-weight:400;font-display:swap;src:url("${href}") format("woff2");unicode-range:${range}}`))
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
    const existing = [...document.querySelectorAll('style#kyg-chapter-font, style[data-kyg-chapter-font]')].map((el) => el.textContent ?? '');
    const hrefs = await Promise.all(meta.map(({ file }) => getUrl.call(storage, id, key, file).catch(() => null)));
    meta.forEach(({ file, range }, i) => {
        const href = hrefs[i];
        if (!isCssSafeUrl(href) || existing.some((css) => css.includes(`url("${href}")`))) return;
        const el = document.createElement('style');
        el.setAttribute('data-kyg-chapter-font', file);
        el.textContent = chapterFontCss({ href, range });
        document.body.appendChild(el);
    });
}
