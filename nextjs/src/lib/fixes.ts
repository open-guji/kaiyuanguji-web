/**
 * 整册读者意见（GUJI-597 反馈设计第四节）：读 COS 上的公开清单 proof/fixes/<书>.json。
 * 清单由每日 proofing-sync 从中心库发布（KV → 中心库 → COS），网站不直接读 KV，所以当天新提的意见次日才出现。
 * 形状见 nextjs/scripts/lib/fixes-sync.mjs 的 toPublicFix。
 */
// 不引 lib/proofing、lib/charfix：它们带着 book-index-ui，这页只是个列表，别拖大。下面几个常量与它们同口径
const PROOF_BASE = process.env.NEXT_PUBLIC_PROOF_SPRITE_BASE || 'https://data.kaiyuanguji.com/proof'; // ＝lib/proofing PROOF_BASE
const CELL_RE = /^\d{1,6}:\d{1,4}:-?\d{1,4}[ab]?$/; // ＝lib/charfix CELL_RE（含抬头字的 -1 格）
/** ＝lib/charfix SPAN_SUBS（接口 edge-functions/api/charfix.js 同序） */
export const SPAN_SUBS = ['wrong', 'missing', 'extra', 'order', 'punct', 'para', 'heading', 'note', 'entity', 'other'] as const;
export type SpanSub = (typeof SPAN_SUBS)[number];

export type FixKind = 'char' | 'span' | 'entity';

export interface PublicFix {
    kind: FixKind;
    /** 起始格位 */
    at: string;
    /** 末格位（一段、专名） */
    end?: string;
    /** 一段的类别 */
    sub?: SpanSub;
    /** 原文（改字的原字、一段的原文、专名原文） */
    old?: string;
    /** 建议（改字的新字、一段的应作） */
    new?: string;
    note?: string;
    /** 文本版本（改字、一段） */
    tv?: string;
    /** 来源的 6 位指纹：只用来数「几个人提的」 */
    who: string;
    ts?: number;
}

/** 同一处（同类、同起止、同类别）的意见并成一组 */
export interface FixGroup {
    key: string;
    kind: FixKind;
    at: string;
    end?: string;
    sub?: SpanSub;
    old?: string;
    items: PublicFix[];
    /** 提的人数（按 who 去重） */
    people: number;
    /** 最近一条的时间 */
    latest: number;
}

const asObj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

function parseFix(raw: unknown): PublicFix | null {
    const o = asObj(raw);
    if (!o) return null;
    const kind = o.kind;
    if (kind !== 'char' && kind !== 'span' && kind !== 'entity') return null;
    const at = str(o.at);
    if (!at || !CELL_RE.test(at)) return null;
    const end = str(o.end);
    const sub = SPAN_SUBS.includes(o.sub as SpanSub) ? (o.sub as SpanSub) : undefined;
    return {
        kind, at,
        ...(end && CELL_RE.test(end) ? { end } : {}),
        ...(kind === 'span' ? { sub: sub ?? 'other' } : {}),
        old: str(o.old), new: str(o.new), note: str(o.note), tv: str(o.tv),
        who: str(o.who) ?? '',
        ts: typeof o.ts === 'number' && Number.isFinite(o.ts) ? o.ts : undefined,
    };
}

/** 公开清单原文 → 本册条目；形状不对的条目丢掉 */
export function parsePublicFixes(raw: unknown, vol: string): PublicFix[] {
    const list = asObj(asObj(raw)?.volumes)?.[vol];
    if (!Array.isArray(list)) return [];
    return list.map(parseFix).filter((x): x is PublicFix => x !== null);
}

/** 格位 页:列:格[ab] 按数值排，同格 a 在 b 前 */
export function cellCompare(a: string, b: string): number {
    const pa = a.match(/^(\d+):(\d+):(-?\d+)([ab]?)$/);
    const pb = b.match(/^(\d+):(\d+):(-?\d+)([ab]?)$/);
    if (!pa || !pb) return a < b ? -1 : a > b ? 1 : 0;
    for (let i = 1; i <= 3; i++) {
        const d = Number(pa[i]) - Number(pb[i]);
        if (d) return d;
    }
    return pa[4] < pb[4] ? -1 : pa[4] > pb[4] ? 1 : 0;
}

/** 按处并组，组按格位排；组内按时间排 */
export function groupFixes(fixes: PublicFix[]): FixGroup[] {
    const map = new Map<string, FixGroup>();
    for (const f of fixes) {
        const key = `${f.kind}|${f.at}|${f.end ?? ''}|${f.sub ?? ''}`;
        let g = map.get(key);
        if (!g) {
            g = { key, kind: f.kind, at: f.at, ...(f.end ? { end: f.end } : {}), ...(f.sub ? { sub: f.sub } : {}), old: f.old, items: [], people: 0, latest: 0 };
            map.set(key, g);
        }
        g.items.push(f);
    }
    const groups = [...map.values()];
    for (const g of groups) {
        g.items.sort((x, y) => (x.ts ?? 0) - (y.ts ?? 0));
        g.people = new Set(g.items.map((x) => x.who)).size;
        g.latest = Math.max(0, ...g.items.map((x) => x.ts ?? 0));
    }
    return groups.sort((x, y) => cellCompare(x.at, y.at) || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
}

const RE_BOOK = /^[0-9a-z]{4,24}$/;
const RE_VOL = /^[A-Za-z0-9._-]{1,16}$/;
export const isFixBook = (b: string) => RE_BOOK.test(b);
export const isFixVol = (v: string) => RE_VOL.test(v);

/** 取一部书的公开清单；书号不合法、取不到给 null（与「没有意见」区分开：null＝没取到） */
export async function loadPublicFixes(book: string, fetchImpl: typeof fetch = fetch, base = PROOF_BASE): Promise<unknown | null> {
    if (!RE_BOOK.test(book)) return null;
    try {
        const res = await fetchImpl(`${base}/fixes/${book}.json`);
        if (res.status === 404) return { book, volumes: {} };
        return res.ok ? await res.json() : null;
    } catch {
        return null;
    }
}

/** 整册意见页地址（静态页，参数走查询串） */
export function fixesPageHref(book: string, vol: string): string {
    return `/feedback/text?book=${encodeURIComponent(book)}&vol=${encodeURIComponent(vol)}`;
}
