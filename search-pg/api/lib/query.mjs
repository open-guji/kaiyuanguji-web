// 边缘函数发来的一条 query → search_one 的参数；hit 的收尾（简介片段高亮）。纯函数，不连库，便于测试。
//
// 请求体（边缘函数已经按白名单规整过，这里再校验一遍，不信上游）：
//   { queries: [{ indexUid, q, limit, offset, filter: [{ field, op: 'eq'|'in', values: [...] }], sort: 'era_rank:asc'|null }] }
// 不接收过滤字符串，只接收 AST；所有值走参数绑定，不拼 SQL。

export const KIND_BY_INDEX = { works: 'work', books: 'book', collections: 'collection', entities: 'entity' };
export const MAX_QUERIES = 4;
export const MAX_LIMIT = 50;
export const MAX_OFFSET = 1000;
export const MAX_QUERY_CHARS = 100;

// 与 edge-functions/api/search.js 的 FILTER_FIELDS 同一份：s＝字符串，b＝布尔
const FILTER_FIELDS = {
    works: { type: 's', dynasty: 's', classification: 's', loss_status: 's', has_image: 'b', has_text: 'b', has_collated: 'b' },
    books: { type: 's', dynasty: 's', has_image: 'b', has_text: 'b' },
    collections: { type: 's' },
    entities: { type: 's', dynasty: 's' },
};
const SORTS = { 'era_rank:asc': 'era:asc', 'era_rank:desc': 'era:desc', 'title_sort:asc': 'title:asc', 'title_sort:desc': 'title:desc' };
const SORT_INDEXES = new Set(['works', 'books', 'entities']);

export class BadRequest extends Error {}

/**
 * 校验并转成 search_one 的调用描述：
 *   { indexUid, kind, empty: boolean, args: [kind, q, limit, offset, dynasty, class, loss, has_text, has_image, has_collated, office, sort] }
 * empty＝筛选与索引类型矛盾（如 type = "book" 打在 works 上），不用查库，直接 0 条。
 */
export function toCall(raw) {
    if (!raw || typeof raw !== 'object') throw new BadRequest('query 须为对象');
    const { indexUid } = raw;
    const kind = KIND_BY_INDEX[indexUid];
    if (!kind) throw new BadRequest(`不支持的索引：${String(indexUid).slice(0, 40)}`);
    if (typeof raw.q !== 'string') throw new BadRequest('缺少 q');
    const q = raw.q.trim();
    if (Array.from(q).length > MAX_QUERY_CHARS) throw new BadRequest('查询过长');
    const limit = clampInt(raw.limit, 5, 1, MAX_LIMIT);
    const offset = clampInt(raw.offset, 0, 0, MAX_OFFSET);

    const f = { dynasty: null, class: null, loss: null, has_text: null, has_image: null, has_collated: null };
    let empty = false;
    const fields = FILTER_FIELDS[indexUid];
    const clauses = raw.filter == null ? [] : raw.filter;
    if (!Array.isArray(clauses) || clauses.length > 6) throw new BadRequest('filter 须为不超过 6 项的数组');
    const seen = new Set();
    for (const c of clauses) {
        if (!c || typeof c !== 'object' || !Array.isArray(c.values) || c.values.length < 1 || c.values.length > 40) throw new BadRequest('filter 项不合法');
        const kindOfField = fields[c.field];
        if (!kindOfField) throw new BadRequest(`该索引不支持按 ${String(c.field).slice(0, 30)} 过滤`);
        if (seen.has(c.field)) throw new BadRequest('filter 字段重复');
        seen.add(c.field);
        if (kindOfField === 'b') {
            if (typeof c.values[0] !== 'boolean') throw new BadRequest(`${c.field} 须为布尔`);
            f[c.field] = c.values[0];
            continue;
        }
        if (!c.values.every((v) => typeof v === 'string' && Array.from(v).length <= 20)) throw new BadRequest(`${c.field} 的值须为短字符串`);
        if (c.field === 'type') { if (!c.values.includes(kind)) empty = true; continue; }
        if (c.field === 'dynasty') f.dynasty = c.values;
        else if (c.field === 'classification') f.class = c.values;
        else if (c.field === 'loss_status') f.loss = c.values;
    }

    let sort = null;
    if (raw.sort != null && raw.sort !== '') {
        sort = SORTS[raw.sort];
        if (!sort) throw new BadRequest('sort 不合法');
        if (!SORT_INDEXES.has(indexUid)) throw new BadRequest(`${indexUid} 索引不支持 sort`);
    }
    return {
        indexUid, kind, empty, q, limit, offset,
        args: [kind, q, limit, offset, f.dynasty, f.class, f.loss, f.has_text, f.has_image, f.has_collated, null, sort],
    };
}

function clampInt(v, dflt, lo, hi) {
    if (v === undefined || v === null || v === '') return dflt;
    const n = Math.trunc(Number(v));
    if (!Number.isFinite(n)) throw new BadRequest('limit/offset 须为数字');
    return Math.min(hi, Math.max(lo, n));
}

export const MARK_START = '\u0001';
export const MARK_END = '\u0002';
export const CROP_LENGTH = 80;
const TERM_RE = /[㐀-鿿豈-﫿\u{20000}-\u{323AF}]|[0-9a-z]+/giu;

/** 把查询串切成「连续的汉字段／字母数字段」，只用来在简介里找命中处 */
function queryRuns(q) {
    const runs = [];
    let cur = '';
    for (const m of q.toLowerCase().matchAll(TERM_RE)) {
        const isLatin = /^[0-9a-z]+$/.test(m[0]);
        if (isLatin) { if (cur) { runs.push(cur); cur = ''; } runs.push(m[0]); } else cur += m[0];
    }
    if (cur) runs.push(cur);
    return runs;
}

/**
 * 简介原文 → 带高亮标记的 80 字片段（与前端 SNIPPET_MARK_START／END 一致）；没有命中返回 undefined。
 * 先找查询里整段词，找不到再退到相邻二字；窗口从第一处命中前 30 字起，不劈开代理对。
 */
export function descriptionSnippet(descr, q) {
    if (typeof descr !== 'string' || !descr) return undefined;
    const text = descr;
    const lower = text.toLowerCase();
    const runs = queryRuns(q);
    const grams = runs.flatMap((r) => (/^[0-9a-z]+$/.test(r) || r.length <= 2 ? [r] : Array.from({ length: r.length - 1 }, (_, i) => r.slice(i, i + 2))));
    let ranges = findAll(lower, runs);
    if (!ranges.length) ranges = findAll(lower, grams);
    if (!ranges.length) return undefined;
    ranges.sort((a, b) => a[0] - b[0]);
    let start = Math.max(0, ranges[0][0] - 30);
    let end = Math.min(text.length, start + CROP_LENGTH);
    if (isLow(text, start)) start -= 1;
    if (end < text.length && isLow(text, end)) end += 1;
    let out = '';
    let pos = start;
    for (const [a, b] of mergeRanges(ranges)) {
        if (b <= start || a >= end) continue;
        const s = Math.max(a, start); const e = Math.min(b, end);
        out += text.slice(pos, s) + MARK_START + text.slice(s, e) + MARK_END;
        pos = e;
    }
    out += text.slice(pos, end);
    return `${start > 0 ? '…' : ''}${out}${end < text.length ? '…' : ''}`;
}

function findAll(lower, terms) {
    const found = [];
    for (const t of new Set(terms)) {
        if (!t) continue;
        for (let i = lower.indexOf(t); i !== -1; i = lower.indexOf(t, i + t.length)) found.push([i, i + t.length]);
    }
    return found;
}
function mergeRanges(sorted) {
    const out = [];
    for (const [a, b] of sorted) {
        const last = out.at(-1);
        if (last && a <= last[1]) last[1] = Math.max(last[1], b); else out.push([a, b]);
    }
    return out;
}
function isLow(s, i) { const c = s.charCodeAt(i); return c >= 0xDC00 && c <= 0xDFFF; }

/** search_one 的返回（{hits, estimatedTotalHits}）→ 对外结果；简介原文换成片段 */
export function shapeResult(call, row, processingTimeMs) {
    const hits = (row.hits || []).map((h) => {
        const { _descr: descr, ...rest } = h;
        const snippet = descr ? descriptionSnippet(descr, call.q) : undefined;
        return snippet ? { ...rest, _formatted: { description_search: snippet } } : rest;
    });
    return {
        indexUid: call.indexUid,
        hits,
        estimatedTotalHits: row.estimatedTotalHits ?? hits.length,
        limit: call.limit,
        offset: call.offset,
        processingTimeMs,
    };
}
