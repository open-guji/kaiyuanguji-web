/**
 * 阅读页「改字」（GUJI-561）：从阅读器 DOM 取格位、算专名命中、提交到 /api/charfix。
 * 规格见 ai-team 仓 team/网站/GUJI-561-charfix-接口规格.md。纯 web：格位来自对读章每个字 span 的 data-char-id（＝char.json 的格位 a）。
 * old_char 一律取 char.json 里该格的原字（不取 DOM 文字：阅读页有繁简切换，DOM 里的字可能是转换后的）。
 */
import { getAid } from '@/lib/proofing';

export const CHARFIX_API = '/api/charfix';

export const CELL_RE = /^\d{1,6}:\d{1,4}:\d{1,4}[ab]?$/;
// 与 edge-functions/api/charfix.js 同口径：单字（含扩展区）或 {{组字式}}
const COMPOSED_RE = /^\{\{[^{}\s\p{Cc}\p{Cf}]{1,30}\}\}$/u;

export const BASIS_MAX = 500;

export function isSingleChar(v: unknown): v is string {
    return typeof v === 'string' && Array.from(v).length === 1 && !/[\p{Cc}\p{Cf}\p{Z}]/u.test(v);
}

export function isNewChar(v: unknown): v is string {
    return typeof v === 'string' && (isSingleChar(v) || COMPOSED_RE.test(v));
}

/** 本章的改字上下文：阅读器取对读数据时顺手记下 */
export interface CharFixCtx {
    book: string;
    /** 册（章条目的 file，如 `002`） */
    volume: string;
    /** 读者看到的文本版本（章条目的 text_version，缺则 char.json 的 version） */
    textVersion: string;
    /** 格位 → char.json 里的原字 */
    chars: Map<string, string>;
    /** 本章专名的 anchor 区间，用来给改字附 entity_ids */
    entities: { id: string; start: string; end: string }[];
}

const asObj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** adaptCharCord 的产物 → 格位到原字（阙文的 □ 也在，old_char 就是 □） */
export function collectChars(pages: unknown): Map<string, string> {
    const out = new Map<string, string>();
    for (const p of Array.isArray(pages) ? pages : []) {
        for (const col of Array.isArray(asObj(p)?.columns) ? (asObj(p)!.columns as unknown[]) : []) {
            for (const ch of Array.isArray(asObj(col)?.chars) ? (asObj(col)!.chars as unknown[]) : []) {
                const c = asObj(ch);
                if (c && typeof c.id === 'string' && typeof c.char === 'string') out.set(c.id, c.char);
            }
        }
    }
    return out;
}

/** entity.json（`entities[]` 或直接数组）→ id 与 anchor 起止；缺 anchor 的丢弃 */
export function collectEntities(raw: unknown): CharFixCtx['entities'] {
    const list = Array.isArray(raw) ? raw : asObj(raw)?.entities;
    const out: CharFixCtx['entities'] = [];
    for (const e of Array.isArray(list) ? list : []) {
        const o = asObj(e);
        const a = asObj(o?.anchor);
        if (typeof o?.id === 'string' && typeof a?.start === 'string' && typeof a?.end === 'string' && CELL_RE.test(a.start) && CELL_RE.test(a.end)) {
            out.push({ id: o.id, start: a.start, end: a.end });
        }
    }
    return out;
}

function parseCell(a: string): { k: [number, number, number]; sub: string } | null {
    if (!CELL_RE.test(a)) return null;
    const m = /^(\d+):(\d+):(\d+)([ab]?)$/.exec(a)!;
    return { k: [Number(m[1]), Number(m[2]), Number(m[3])], sub: m[4] };
}

const cmp = (x: number[], y: number[]) => { for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };

/**
 * 这一格落在哪些专名的 anchor 区间里。按（页，列，格序）比；起止同为夹注 a／b 行时，该格也须在同一行。
 * 算不出（格位不合法）就空——规格：算不出就空。
 */
export function entityIdsAt(cell: string, entities: CharFixCtx['entities']): string[] {
    const c = parseCell(cell);
    if (!c) return [];
    const ids: string[] = [];
    for (const e of entities) {
        const s = parseCell(e.start);
        const t = parseCell(e.end);
        if (!s || !t || cmp(c.k, s.k) < 0 || cmp(c.k, t.k) > 0) continue;
        if (s.sub && s.sub === t.sub && c.sub !== s.sub) continue;
        ids.push(e.id);
    }
    return ids;
}

/** 点击处最近的字 span 的格位；不在对读字上、或格位不合法就是 null */
export function cellIdOf(target: EventTarget | null): string | null {
    const el = target instanceof Element ? target : (target as Node | null)?.parentElement ?? null;
    const id = el?.closest('[data-char-id]')?.getAttribute('data-char-id') ?? null;
    return id && CELL_RE.test(id) ? id : null;
}

export interface CharFixDraft {
    cell: string;
    newChar: string;
    basis: string;
}

/** 提交一条改字；失败返回错误文案，成功返回 null。不抛 */
export async function submitCharFix(ctx: CharFixCtx, d: CharFixDraft, fetchImpl: typeof fetch = fetch): Promise<string | null> {
    const oldChar = ctx.chars.get(d.cell);
    const body = {
        kind: 'char',
        book_id: ctx.book,
        volume: ctx.volume,
        text_version: ctx.textVersion,
        cell_id: d.cell,
        ...(oldChar ? { old_char: oldChar } : {}),
        new_char: d.newChar,
        ...(d.basis ? { basis: d.basis } : {}),
        entity_ids: entityIdsAt(d.cell, ctx.entities),
        aid: getAid(),
    };
    try {
        const res = await fetchImpl(CHARFIX_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        let out: { success?: boolean; error?: string } | null = null;
        try { out = await res.json(); } catch { /* 非 JSON：按状态码给文案 */ }
        if (res.ok && out?.success !== false) return null;
        if (res.status === 429) return '提交太頻繁，請稍後再試';
        return out?.error || `提交失敗（${res.status}）`;
    } catch {
        return '網絡出錯，請稍後再試';
    }
}
