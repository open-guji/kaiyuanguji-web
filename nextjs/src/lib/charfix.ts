/**
 * 阅读页「改字」（GUJI-561）：从阅读器 DOM 取格位、算专名命中、提交到 /api/charfix。
 * 规格见 ai-team 仓 team/网站/GUJI-561-charfix-接口规格.md。纯 web：格位来自对读章每个字 span 的 data-char-id（＝char.json 的格位 a）。
 * old_char 一律取 char.json 里该格的原字（不取 DOM 文字：阅读页有繁简切换，DOM 里的字可能是转换后的）。
 */
import { getAid } from '@/lib/proofing';
import { getSiteT, type SiteT } from '@/i18n/translate';

export const CHARFIX_API = '/api/charfix';

export const CELL_RE = /^\d{1,6}:\d{1,4}:-?\d{1,4}[ab]?$/; // 含抬头字的 -1 格
/** 与接口同口径的版本号（text_version／entity_version）；对不上就当没有 */
export const VERSION_RE = /^[A-Za-z0-9._-]{1,16}$/;
const ENTITY_ID_RE = /^e\d{1,8}$/;
const TEXT_MAX = 200;
export const NOTE_MAX = 500;
// 与 edge-functions/api/charfix.js 同口径：单字（含扩展区）或 {{组字式}}
const COMPOSED_RE = /^\{\{[^{}\s\p{Cc}\p{Cf}]{1,30}\}\}$/u;

export const BASIS_MAX = 500;

export function isSingleChar(v: unknown): v is string {
    return typeof v === 'string' && Array.from(v).length === 1 && !/[\p{Cc}\p{Cf}\p{Z}]/u.test(v);
}

export function isNewChar(v: unknown): v is string {
    return typeof v === 'string' && (isSingleChar(v) || COMPOSED_RE.test(v));
}

/** 一个专名：册内 id（entity.json 的 entities[].id，e01384 形）、anchor 起止格位、原文 */
export interface CharFixEntity {
    id: string;
    start: string;
    end: string;
    /** entity.json 的 text；缺了为空串（那条不出「专名有误」入口：接口要 text 回找） */
    text: string;
}

/** 本章的改字上下文：阅读器取对读数据时顺手记下 */
export interface CharFixCtx {
    book: string;
    /** 册（章条目的 file，如 `002`） */
    volume: string;
    /** 章（阅读器的章 key，即章条目的 file）。现有数据一章一册，与 volume 同值；专名意见必填（GUJI-592） */
    chapter: string;
    /**
     * 读者看到的文本版本（章条目的 text_version，缺则 char.json 的 version）。两处都没有时为空串：
     * 改字记录要按版本落键、下游按版本核，猜一个版本会把意见挂错，所以此时不收改字（浮条里说明），专名意见照收（它只认 entity_version）
     */
    textVersion: string;
    /** 格位 → char.json 里的原字 */
    chars: Map<string, string>;
    /** 本章专名的 anchor 区间，用来给改字附 entity_ids、出「专名有误」入口 */
    entities: CharFixEntity[];
    /** 专名层版本（章条目的 entity_version，缺则 entity.json 的 version）；空串＝本章没有可用的专名层，不出「专名有误」 */
    entityVersion: string;
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

/** entity.json（`entities[]` 或直接数组）→ id、anchor 起止与原文；缺 anchor 的丢弃 */
export function collectEntities(raw: unknown): CharFixEntity[] {
    const list = Array.isArray(raw) ? raw : asObj(raw)?.entities;
    const out: CharFixEntity[] = [];
    for (const e of Array.isArray(list) ? list : []) {
        const o = asObj(e);
        const a = asObj(o?.anchor);
        if (typeof o?.id === 'string' && typeof a?.start === 'string' && typeof a?.end === 'string' && CELL_RE.test(a.start) && CELL_RE.test(a.end)) {
            out.push({ id: o.id, start: a.start, end: a.end, text: typeof o.text === 'string' ? o.text.trim() : '' });
        }
    }
    return out;
}

/** entity.json 自带的 version（章条目没写 entity_version 时兜底）；不合法为空串 */
export function entityFileVersion(raw: unknown): string {
    const v = asObj(raw)?.version;
    return typeof v === 'string' && VERSION_RE.test(v) ? v : '';
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
export function entitiesAt(cell: string, entities: CharFixEntity[]): CharFixEntity[] {
    const c = parseCell(cell);
    if (!c) return [];
    const hit: CharFixEntity[] = [];
    for (const e of entities) {
        const s = parseCell(e.start);
        const t = parseCell(e.end);
        if (!s || !t || cmp(c.k, s.k) < 0 || cmp(c.k, t.k) > 0) continue;
        if (s.sub && s.sub === t.sub && c.sub !== s.sub) continue;
        hit.push(e);
    }
    return hit;
}

export function entityIdsAt(cell: string, entities: CharFixEntity[]): string[] {
    return entitiesAt(cell, entities).map((e) => e.id);
}

/** 「专名有误」能提交的专名：本章有专名层版本，且该条 id、原文都合接口口径 */
export function reportableEntitiesAt(cell: string, ctx: CharFixCtx): CharFixEntity[] {
    if (!VERSION_RE.test(ctx.entityVersion)) return [];
    return entitiesAt(cell, ctx.entities).filter((e) => ENTITY_ID_RE.test(e.id) && e.text && Array.from(e.text).length <= TEXT_MAX);
}

/** 本章能不能收改字：要有合口径的 text_version */
export const canFixChar = (ctx: CharFixCtx) => VERSION_RE.test(ctx.textVersion);

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

const HANT = getSiteT('zh-Hant');

async function post(body: Record<string, unknown>, fetchImpl: typeof fetch, t: SiteT): Promise<string | null> {
    try {
        const res = await fetchImpl(CHARFIX_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        let out: { success?: boolean; error?: string } | null = null;
        try { out = await res.json(); } catch { /* 非 JSON：按状态码给文案 */ }
        if (res.ok && out?.success !== false) return null;
        if (res.status === 429) return t('charfix.error.rate');
        return out?.error || t('charfix.error.failed', { status: res.status });
    } catch {
        return t('charfix.error.network');
    }
}

/** 提交一条改字；失败返回错误文案，成功返回 null。不抛 */
export async function submitCharFix(ctx: CharFixCtx, d: CharFixDraft, fetchImpl: typeof fetch = fetch, t: SiteT = HANT): Promise<string | null> {
    const oldChar = ctx.chars.get(d.cell);
    return post({
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
    }, fetchImpl, t);
}

/** 提交一条专名意见（kind=entity；必填 entity_id＋册／章／锚点格号，见 GUJI-592）。失败返回错误文案，成功返回 null。不抛 */
export async function submitEntityFix(ctx: CharFixCtx, d: { entity: CharFixEntity; note: string }, fetchImpl: typeof fetch = fetch, t: SiteT = HANT): Promise<string | null> {
    return post({
        kind: 'entity',
        book_id: ctx.book,
        volume: ctx.volume,
        chapter: ctx.chapter,
        entity_id: d.entity.id,
        entity_version: ctx.entityVersion,
        anchor: { start: d.entity.start, end: d.entity.end },
        text: d.entity.text,
        note: d.note,
        aid: getAid(),
    }, fetchImpl, t);
}

/** 拖选一段报问题（kind=span）：类别与接口 SPAN_SUBS 同序。错字 缺字 多字 次序 标点 分段 标题 小注 专名 其他 */
export const SPAN_SUBS = ['wrong', 'missing', 'extra', 'order', 'punct', 'para', 'heading', 'note', 'entity', 'other'] as const;
export type SpanSub = (typeof SPAN_SUBS)[number];
export const SPAN_TEXT_MAX = 64;

/** 选区落在的对读字：首末格位与这段原字（按 char.json，不取 DOM 文字）。选区里没有对读字就是 null */
export interface SpanSel {
    start: string;
    end: string;
    /** 选区里的原字，按读序连起来；超过 SPAN_TEXT_MAX 截断 */
    text: string;
    /** 选区覆盖的字数 */
    count: number;
}

/**
 * 选区 → 首末格位。只认 root 里带 data-char-id 的字 span，按文档序取第一个与最后一个；
 * 同一格位出现多次（对读版面左右两栏）只算一次。
 */
export function spanOfRange(range: Range, root: HTMLElement, chars: Map<string, string>): SpanSel | null {
    const ids: string[] = [];
    const seen = new Set<string>();
    for (const el of Array.from(root.querySelectorAll('[data-char-id]'))) {
        if (!range.intersectsNode(el)) continue;
        const id = el.getAttribute('data-char-id');
        if (!id || !CELL_RE.test(id) || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
    }
    if (ids.length === 0) return null;
    const text = Array.from(ids.map((id) => chars.get(id) ?? '').join('')).slice(0, SPAN_TEXT_MAX).join('');
    return { start: ids[0], end: ids[ids.length - 1], text, count: ids.length };
}

export interface SpanFixDraft {
    span: SpanSel;
    sub: SpanSub;
    newText: string;
    note: string;
}

/** 提交一条「这段有问题」（kind=span）。失败返回错误文案，成功返回 null。不抛 */
export async function submitSpanFix(ctx: CharFixCtx, d: SpanFixDraft, fetchImpl: typeof fetch = fetch, t: SiteT = HANT): Promise<string | null> {
    return post({
        kind: 'span',
        book_id: ctx.book,
        volume: ctx.volume,
        text_version: ctx.textVersion,
        start: d.span.start,
        end: d.span.end,
        sub: d.sub,
        ...(d.span.text ? { old_text: d.span.text } : {}),
        ...(d.newText ? { new_text: d.newText } : {}),
        ...(d.note ? { note: d.note } : {}),
        aid: getAid(),
    }, fetchImpl, t);
}
