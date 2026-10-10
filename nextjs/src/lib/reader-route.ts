/**
 * 阅读页 /read/<id> 的地址约定（overview#307 E 块，规格 overview 项目进展/古籍索引网站/设计/阅读文本.md §六）。
 * 路径式 URL，只认新结构（manifest＋<key>/）：
 *
 *   /read/<id>                   主版本第一章（主版本＝阅读页 manifest 的 default；作品另有全文版而 default 是目录型时，default 不列出，主版本是第一份全文版，见 lib/reader-manifest.ts）
 *   /read/<id>/<章>              主版本某章，章用三位编号（如 /read/d59ezkx8dt6o/003）
 *   /read/<id>/<key>             其他版本第一章
 *   /read/<id>/<key>/<章>        其他版本某章（如 /read/d59ezkx8dt6o/wikisource-2/003）
 *
 * - 主版本的 URL 里不写 default：`/read/<id>/default[/<章>]` 308 到不带 default 的形式；
 * - 第二段纯数字＝章号，以字母开头＝版本 key（key 必须以字母开头，见 isTextKey）；
 * - canonical：主版本 `/read/<id>/<章>`，其他版本 `/read/<id>/<key>/<章>`（不带章号的短地址 200 显示，canonical 指向第一章的全形）；
 * - 旧地址（?kind=&key=&juan=、/item/<id>/read、?tab=）的 308 见 legacy-reader.ts。
 *
 * 纯函数，不依赖 React／Next：页面、中间件（边缘运行时）、测试共用。
 * key／章的形态规则与 book-index-ui 的 core/text-model 一致（中间件里不拉整个 UI 包，这里单写一份）。
 */
import { parseItemId } from './item-id';

/** 版本选择：key 缺省＝主版本（见上，通常是 default）；chapter 缺省＝第一章 */
export interface ReaderSel {
    key?: string;
    chapter?: string;
}

/** 非主版本的 key 不能用的保留字（规格 §二）；default 是主版本专用 */
const RESERVED_KEYS = ['default', 'manifest', 'fragments', 'sources', 'extra'];

/** 合法的版本 key：主版本固定 default；其余 [a-z0-9-]、字母开头、非保留字 */
export function isTextKey(key: string): boolean {
    if (key === 'default') return true;
    return /^[a-z][a-z0-9-]*$/.test(key) && !RESERVED_KEYS.includes(key);
}

/** URL 片段是章号（纯数字）还是版本 key（字母开头） */
export function isChapterSegment(seg: string): boolean {
    return /^[0-9]{1,6}$/.test(seg);
}

/** 有阅读页的条目类型：Work 与 Book（整理本与全文都是「文本」）；其余类型没有 */
export function hasReaderType(id: string): boolean {
    const t = parseItemId(id)?.type;
    return t === 'work' || t === 'book';
}

/** 阅读页路径。key 为 default 或空＝主版本，不写进路径；chapter 空＝不带章号的短地址 */
export function readerPath(id: string, sel: ReaderSel = {}): string {
    const parts = [sel.key && sel.key !== 'default' ? sel.key : '', sel.chapter ?? ''].filter(Boolean);
    return `/read/${id}${parts.map((p) => `/${p}`).join('')}`;
}

/** 同 readerPath，保留旧名（条目页「阅读全文」、翻章同步地址栏都用它） */
export const readerHref = readerPath;

export type ReaderParse =
    | { sel: ReaderSel }
    /** 地址写了 default：308 到不带 default 的形式 */
    | { redirect: string };

/**
 * 解析 /read/<id>/… 的路径段（[id] 之后的部分）。条目类型没有阅读页、形态不对 → null（页面 404）。
 * 章号只看形态（纯数字），在不在目录里由服务端按 manifest／目录校验。
 */
export function parseReaderSegments(id: string, segs: readonly string[] | undefined): ReaderParse | null {
    if (!hasReaderType(id)) return null;
    const s = segs ?? [];
    if (s.length === 0) return { sel: {} };
    if (s.length === 1) {
        const [a] = s;
        if (a === 'default') return { redirect: readerPath(id) };
        if (isChapterSegment(a)) return { sel: { chapter: a } };
        if (isTextKey(a)) return { sel: { key: a } };
        return null;
    }
    if (s.length === 2) {
        const [a, b] = s;
        if (!isChapterSegment(b)) return null;
        if (a === 'default') return { redirect: readerPath(id, { chapter: b }) };
        if (isTextKey(a)) return { sel: { key: a, chapter: b } };
    }
    return null;
}

/** 从 /read/ 之后的路径名切出 id 与其后的段；不是阅读页路径返回 null */
export function splitReaderPathname(pathname: string): { id: string; segs: string[] } | null {
    const m = /^\/read\/([^/]+)((?:\/[^/]+)*)\/?$/.exec(pathname);
    if (!m) return null;
    return { id: m[1], segs: m[2].split('/').filter(Boolean) };
}

/** 章的显示名兜底（目录里没有章名时，<title> 用）：三位编号 003 → 卷3 */
export function chapterFallbackLabel(chapter: string): string {
    const n = chapter.match(/(\d+)$/)?.[1];
    return n ? `卷${Number(n)}` : chapter;
}

/**
 * 页面上给读者看的版本名（<title>、og:title、描述、反馈标签）：**默认版本不写**，非默认版本写来源名（如「維基文庫」）；
 * 版本有 edition_label（底本名，book-text 901182c50b 起可选）时写「版本名 · 来源名」，如「四部叢刊本 · Kanripo」（overview#307，与 bim textVersionLabel 同规则）。
 * 用户 10-01 定：页面上不再出现「整理本」「转录全文」「全文」这类类别词，统一叫「文本」；版本下拉也只写来源。
 * 数据里的版本 label 本就只写来源，这里再兜一道：若 label 是类别词就改用 source_name，都没有就只写版本名，再没有就不写。
 */
const CATEGORY_WORD = /^(整理本|整理|转录全文|轉錄全文|转录|轉錄|全文|文本)$/;
export function readerVersionName(v?: { key?: string; label?: string; source_name?: string; edition_label?: string } | null): string | undefined {
    if (!v || !v.key || v.key === 'default') return undefined;
    let source: string | undefined;
    for (const cand of [v.label, v.source_name]) {
        const s = cand?.trim();
        if (s && !CATEGORY_WORD.test(s)) { source = s; break; }
    }
    const edition = v.edition_label?.trim();
    if (edition && edition !== source) return source ? `${edition} · ${source}` : edition;
    return source;
}

/**
 * 阅读页 <title>：「书名 · 章名 · 版本名」。
 * chapterTitle 是目录里的章名（如红楼梦的「第三回」），没有就用「卷N」；版本名用 readerVersionName（默认版本不写、非默认只写来源）。
 */
export function readerTitle(bookTitle: string, chapter: string | undefined, chapterTitle?: string, versionLabel?: string): string {
    return [bookTitle, chapterTitle?.trim() || (chapter ? chapterFallbackLabel(chapter) : ''), versionLabel?.trim() ?? '']
        .filter(Boolean)
        .join(' · ');
}
