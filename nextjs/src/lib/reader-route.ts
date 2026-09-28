/**
 * N5b：阅读页 /item/<id>/read 的地址约定（与 N3b 条目页的「阅读全文」共用）。
 *
 *   /item/<id>/read?kind=collated|fulltext[&key=<fullTextKey>][&juan=<卷>]
 *
 *   - kind=collated：整理本（Work），juan 是卷文件名（如 juan/011.json）；
 *   - kind=fulltext：全文（Book，或 Work 带 key 选其中一份），juan 是章节 stem（如 001）；
 *   - key 只对 Work 全文有意义，不带就由阅读器取首选那份。
 *
 * 纯函数，不依赖 React／Next：页面、中间件（边缘运行时）、测试共用。
 */
import { parseItemId } from './item-id';

export type ReaderKind = 'collated' | 'fulltext';

export interface ReaderQuery {
    kind: ReaderKind;
    key?: string;
    juan?: string;
}

type ParamSource = URLSearchParams | Record<string, string | string[] | undefined>;

function first(src: ParamSource, name: string): string | undefined {
    if (src instanceof URLSearchParams) return src.get(name) ?? undefined;
    const v = src[name];
    return (Array.isArray(v) ? v[0] : v) ?? undefined;
}

function isKind(v: string | undefined): v is ReaderKind {
    return v === 'collated' || v === 'fulltext';
}

/** 不带 kind 时按条目类型取默认：Work 看整理本，Book 看全文；其余类型没有阅读页 */
export function defaultReaderKind(id: string): ReaderKind | null {
    const t = parseItemId(id)?.type;
    return t === 'work' ? 'collated' : t === 'book' ? 'fulltext' : null;
}

/**
 * 解析阅读页查询串。kind 不合法、条目类型没有这种阅读页（整理本只有 Work，全文只有 Work／Book）
 * → null（页面 404）。kind 缺省按类型取默认；空的 key／juan 视同没带。
 */
export function parseReaderQuery(id: string, src: ParamSource): ReaderQuery | null {
    const type = parseItemId(id)?.type;
    const rawKind = first(src, 'kind');
    const kind = rawKind === undefined ? defaultReaderKind(id) : isKind(rawKind) ? rawKind : null;
    if (!kind) return null;
    if (kind === 'collated' ? type !== 'work' : type !== 'work' && type !== 'book') return null;
    const q: ReaderQuery = { kind };
    const key = first(src, 'key');
    const juan = first(src, 'juan');
    if (key && kind === 'fulltext') q.key = key;
    if (juan) q.juan = juan;
    return q;
}

/** 拼阅读页地址。参数顺序固定（kind、key、juan），canonical 与跳转目标因此唯一 */
export function readerHref(id: string, q: ReaderQuery): string {
    const p = new URLSearchParams();
    p.set('kind', q.kind);
    if (q.key && q.kind === 'fulltext') p.set('key', q.key);
    if (q.juan) p.set('juan', q.juan);
    return `/item/${id}/read?${p.toString()}`;
}

/**
 * 卷的显示名，给 <title> 用：取末段、去扩展名，末尾是数字就写成「卷N」。
 *   juan/011.json → 卷11；001 → 卷1；第001 → 卷1；序 → 序
 */
export function juanLabel(juan: string): string {
    const stem = (juan.split('/').pop() ?? juan).replace(/\.(json|md)$/, '');
    const m = stem.match(/(\d+)$/);
    return m ? `卷${Number(m[1])}` : stem;
}

/** 阅读页 <title>：「书名 · 卷N · 整理本／全文」 */
export function readerTitle(bookTitle: string, q: ReaderQuery): string {
    return [bookTitle, q.juan ? juanLabel(q.juan) : '', q.kind === 'collated' ? '整理本' : '全文']
        .filter(Boolean)
        .join(' · ');
}

/**
 * 旧入口 → 新阅读页（保留卷号）。不是旧阅读入口就返回 null。
 *
 *   /book-index?id=<id>&tab=fulltext|collated[&juan=…]
 *   /item/<id>?tab=fulltext|collated[&juan=…]
 *
 * 只认 tab 为 fulltext／collated 的；其余参数（page、mode 等）是别的 tab 的状态，丢掉。
 * redirected_from／no_redirect（草稿升格横幅的往返）在场时放过，留给详情组件处理。
 */
export function legacyReaderTarget(pathname: string, params: URLSearchParams): string | null {
    const tab = params.get('tab');
    if (!isKind(tab ?? undefined)) return null;
    if (params.has('redirected_from') || params.has('no_redirect')) return null;

    let id: string | null = null;
    if (pathname === '/book-index') id = params.get('id');
    else if (pathname.startsWith('/item/')) id = pathname.slice('/item/'.length);
    if (!id) return null;

    // 条目类型没有这种阅读页（如 Book 的 tab=collated）就不跳，免得跳进 404
    const q = parseReaderQuery(id, { kind: tab ?? undefined, juan: params.get('juan') ?? undefined });
    return q ? readerHref(id, q) : null;
}
