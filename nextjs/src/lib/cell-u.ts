/**
 * 字格永久编号 u（guji-char v0.6，CV0 2026-11-24 定，规范 guji-format spec/02 §4.10）。
 *
 * 格位 a（`页:列:格[子列]`）是位置：补一个字、重切一次，后面的格号都会变；u 是身份：册内唯一正整数，发了永不改、永不复用。
 * 网站这边：
 *   - 阅读器从 char.json 读出每格的 u（老文本没有 u，照常只用格位）；
 *   - 深链 `/read/<书>/<册>?u=<n>`（或范围 `?u=<n>~<m>`）按 u 找格；旧的 `#页:列:格` 照旧可用，另收 `?cell=页:列:格`；
 *   - 人审票、改字意见、选字报错提交时，有 u 就一并带上（双写期：键仍按格位，u 只进值）。
 * 这里只放纯函数，不引 book-index-ui（列表页也要用）。
 */

/** 与接口 edge-functions/api/feedback.js 的 U_MAX 同 */
export const U_MAX = 99_999_999;
const CELL_RE = /^\d{1,6}:\d{1,4}:-?\d{1,4}[ab]?$/; // ＝lib/charfix CELL_RE

export const isU = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= U_MAX;

/** 本章格位 ↔ u 的对照；char.json 没有 u（v0.5 及以前）时两个表都空 */
export interface UIndex {
    byA: Map<string, number>;
    byU: Map<number, string>;
}

export const EMPTY_U_INDEX: UIndex = { byA: new Map(), byU: new Map() };

const asObj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * char.json 原文 → 格位与 u 的对照（pages[].columns[].cells[] 的 `a`、`u`）。
 * 不合法的 u 跳过；同一个 u 出现两次（数据坏了）两格都不认，免得深链跳错格。
 */
export function collectU(rawChar: unknown): UIndex {
    const byA = new Map<string, number>();
    const byU = new Map<number, string>();
    const dup = new Set<number>();
    for (const p of arr(asObj(rawChar)?.pages)) {
        for (const col of arr(asObj(p)?.columns)) {
            for (const cell of arr(asObj(col)?.cells)) {
                const c = asObj(cell);
                const a = c?.a;
                const u = c?.u;
                if (typeof a !== 'string' || !CELL_RE.test(a) || !isU(u)) continue;
                if (byU.has(u)) { dup.add(u); continue; }
                byA.set(a, u);
                byU.set(u, a);
            }
        }
    }
    for (const u of dup) {
        const a = byU.get(u);
        if (a !== undefined) byA.delete(a);
        byU.delete(u);
    }
    return { byA, byU };
}

/** 地址里按格定位的请求：`?u=<n>`／`?u=<n>~<m>`（u 优先），或 `?cell=页:列:格[~页:列:格]` */
export type CellLink = { u: number; uEnd?: number } | { cell: string };

/** 查询串 → 按格定位的请求；都没有或不合法为 null */
export function parseCellLink(search: string): CellLink | null {
    let q: URLSearchParams;
    try { q = new URLSearchParams(search); } catch { return null; }
    const uRaw = q.get('u');
    if (uRaw) {
        const m = /^(\d{1,8})(?:~(\d{1,8}))?$/.exec(uRaw.trim());
        if (m) {
            const u = Number(m[1]);
            const uEnd = m[2] !== undefined ? Number(m[2]) : undefined;
            if (isU(u) && (uEnd === undefined || isU(uEnd))) return uEnd !== undefined && uEnd !== u ? { u, uEnd } : { u };
        }
    }
    const cell = (q.get('cell') ?? '').trim();
    if (cell) {
        const [s, e] = cell.split('~');
        if (CELL_RE.test(s) && (e === undefined || CELL_RE.test(e))) return { cell };
    }
    return null;
}

/**
 * 按格定位的请求 → 阅读器的章内锚点（`页:列:格`，或范围 `起~止`）。
 * u 在本章查不到（不是这一册、或本章 char 还没有 u）返回 null，交给地址的 #格位 兜底。
 */
export function resolveCellLink(link: CellLink | null, idx: UIndex): string | null {
    if (!link) return null;
    if ('cell' in link) return link.cell;
    const a = idx.byU.get(link.u);
    if (!a) return null;
    if (link.uEnd === undefined) return a;
    const b = idx.byU.get(link.uEnd);
    return b ? `${a}~${b}` : a;
}

/**
 * 某格（或一段）在阅读页的地址：有 u 写 `?u=`，同时把格位写进 #（不认 ?u= 的旧页面、u 查不到时都还能跳到）。
 * 格位不合法、也没有 u，就只给册的地址。
 */
export function cellHref(book: string, vol: string, at: { a?: string; u?: number; end?: string; uEnd?: number }): string {
    const base = `/read/${book}/${vol}`;
    const u = isU(at.u) ? (isU(at.uEnd) && at.uEnd !== at.u ? `${at.u}~${at.uEnd}` : String(at.u)) : '';
    const a = at.a && CELL_RE.test(at.a) ? (at.end && at.end !== at.a && CELL_RE.test(at.end) ? `${at.a}~${at.end}` : at.a) : '';
    return `${base}${u ? `?u=${u}` : ''}${a ? `#${a}` : ''}`;
}

/**
 * 章内锚点（`页:列:格` 或范围 `起~止`）→ 查询串 `u=` 的值（`n` 或 `n~m`）。本章 char 没有 u、或不是格位（如 `e=…`）返回 null。
 * 阅读页读者点目录标题时用：地址除了 #格位 再写上 ?u=，转发出去的链接跨重切不漂。
 */
export function anchorToU(anchor: string | null | undefined, idx: UIndex): string | null {
    if (!anchor) return null;
    const [a, b, ...rest] = anchor.split('~');
    if (rest.length || !CELL_RE.test(a) || (b !== undefined && !CELL_RE.test(b))) return null;
    const u = idx.byA.get(a);
    if (u === undefined) return null;
    if (b === undefined || b === a) return String(u);
    const ue = idx.byA.get(b);
    return ue === undefined || ue === u ? String(u) : `${u}~${ue}`;
}

/** 提交用：u 合法才带 */
export const uField = (u: number | undefined): { u?: number } => (isU(u) ? { u } : {});

/** 提交用：起止 u 都合法才带（接口要求两个一起给） */
export function uPairFields(s: number | undefined, e: number | undefined): { u_start?: number; u_end?: number } {
    return isU(s) && isU(e) ? { u_start: s, u_end: e } : {};
}
