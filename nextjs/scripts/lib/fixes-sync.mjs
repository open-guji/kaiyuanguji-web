/**
 * fixes-sync.mjs — 读者改字／一段有问题／专名意见（/api/charfix 的 cf:／cs:／ce: 记录）每日进中心库、发公开清单（GUJI-597 反馈设计第四节）
 *
 *   opinions 段：网站 KV 管理读 /api/charfix?book=&kind=char|span|entity → 中心库 feedback/lists/web/<书>/fixes.jsonl
 *               （旧快照 ∪ KV，同一条以 KV 为准；KV 180 天 TTL 过期的旧条目保留）
 *   publish 段：中心库 fixes.jsonl → COS [前缀/]proof/fixes/<书>.json（公开：去掉 voter 原值、正文脱敏、不带时间戳以外的来源信息）
 * 网站（国内站）不写中心库：写中心库的是本 Action。纯函数在这里，单测见 fixes-sync.test.mjs。
 */
import { cellOrder } from './proofing-sync-plan.mjs';
import { desensitizeText } from '../../../edge-functions/api/feedback.js';

export const FIX_KINDS = ['char', 'span', 'entity'];
/** /api/thread 管理读的两类：表态（同意／有不同看法）、回复 */
export const THREAD_KINDS = ['vote', 'reply'];
const RE_BOOK = /^[0-9a-z]{4,24}$/;

export function fixesSnapshotPath(book) {
    if (!RE_BOOK.test(book)) throw new Error(`book 无效：${book}`);
    return `feedback/lists/web/${book}/fixes.jsonl`;
}

export function threadsSnapshotPath(book) {
    if (!RE_BOOK.test(book)) throw new Error(`book 无效：${book}`);
    return `feedback/lists/web/${book}/threads.jsonl`;
}

/** 站方隐藏单：一行一个 id（fixId 或 threadId），# 起为注释。公开清单里不出这些条目 */
export function hiddenListPath(book) {
    if (!RE_BOOK.test(book)) throw new Error(`book 无效：${book}`);
    return `feedback/lists/web/${book}/hidden.txt`;
}

export function parseHidden(text) {
    return new Set((text || '').split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean));
}

export function fixesPublicKey(book) {
    if (!RE_BOOK.test(book)) throw new Error(`book 无效：${book}`);
    return `fixes/${book}.json`;
}

/** 一条记录的身份（与 KV key 同口径：同来源对同一处再提是覆盖） */
export function fixId(r) {
    if (!r || typeof r !== 'object' || typeof r.voter !== 'string' || typeof r.volume !== 'string') return null;
    if (r.kind === 'char' && typeof r.cell_id === 'string') return `cf|${r.volume}|${r.text_version}|${r.cell_id}|${r.voter}`;
    if (r.kind === 'span' && typeof r.start === 'string' && typeof r.end === 'string') return `cs|${r.volume}|${r.text_version}|${r.start}-${r.end}|${r.sub}|${r.voter}`;
    if (r.kind === 'entity' && typeof r.entity_id === 'string') return `ce|${r.volume}|${r.entity_id}|${r.voter}`;
    return null;
}

/** 讨论一条的身份：表态同来源同处覆盖；回复按时间追加 */
export function threadId(r) {
    if (!r || typeof r !== 'object' || typeof r.voter !== 'string' || typeof r.volume !== 'string' || typeof r.target !== 'string') return null;
    if (r.stance === 'agree' || r.stance === 'disagree') return `tv|${r.volume}|${r.target}|${r.voter}`;
    if (r.stance === 'reply' && typeof r.ts === 'number') return `tm|${r.volume}|${r.target}|${r.ts}|${r.voter}`;
    return null;
}

/** 一处意见的 target（与 /api/thread、网站 lib/fixes 同口径） */
export function targetOf(r) {
    const sub = r.kind === 'span' ? (r.sub ?? '') : '';
    const end = r.kind === 'char' ? '' : (r.kind === 'span' ? r.end : r.anchor?.end) ?? '';
    return `${r.kind}~${fixAt(r)}~${end}~${sub}`;
}

/** 键排序后序列化（同内容 → 同字节，KV 键序不同也一样） */
function canon(v) {
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
    return v;
}

/** 一条记录的起始格位（排序与公开清单用） */
export function fixAt(r) {
    if (r.kind === 'char') return r.cell_id;
    if (r.kind === 'span') return r.start;
    return r.anchor?.start ?? '';
}

function cmpFix(x, y) {
    if (x.volume !== y.volume) return x.volume < y.volume ? -1 : 1;
    const c = cellOrder(fixAt(x), fixAt(y));
    if (c) return c;
    const a = fixId(x), b = fixId(y);
    return a < b ? -1 : a > b ? 1 : 0;
}

function parseLines(text) {
    const out = [];
    let bad = 0;
    for (const line of (text || '').split('\n')) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch { bad++; }
    }
    return { records: out, bad };
}

/**
 * 合成新快照：旧快照 ∪ KV，同 fixId 以 KV 为准。只收本书、身份认得出的记录。
 * @returns {{text, total, added, updated, kept, dropped}}
 */
export function mergeFixes(oldText, kvItems, book, idOf = fixId) {
    const byId = new Map();
    for (const r of parseLines(oldText).records) {
        const id = r?.book_id === book ? idOf(r) : null;
        if (id) byId.set(id, canon(r));
    }
    const oldIds = new Set(byId.keys());
    const seen = new Set();
    let added = 0, updated = 0, dropped = 0;
    for (const raw of kvItems || []) {
        const id = raw?.book_id === book ? idOf(raw) : null;
        if (!id) { dropped++; continue; }
        seen.add(id);
        const rec = canon(raw);
        const prev = byId.get(id);
        if (!prev) added++;
        else if (JSON.stringify(prev) !== JSON.stringify(rec)) updated++;
        byId.set(id, rec);
    }
    const kept = [...oldIds].filter((k) => !seen.has(k)).length;
    const all = idOf === fixId ? [...byId.values()].sort(cmpFix) : [...byId.entries()].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)).map((e) => e[1]);
    const text = all.map((r) => JSON.stringify(r)).join('\n') + (all.length ? '\n' : '');
    return { text, total: all.length, added, updated, kept, dropped };
}

const clean = (s) => (typeof s === 'string' && s ? desensitizeText(s) : undefined);

/** 一条记录的公开形：不带 voter 原值（只给 6 位，区分「几个人提的」）、不带 aid／IP（本来就没存）、正文脱敏 */
export function toPublicFix(r) {
    const o = { kind: r.kind, at: fixAt(r), who: String(r.voter).slice(0, 6), ts: typeof r.ts === 'number' ? r.ts : undefined };
    if (r.kind === 'char') Object.assign(o, { tv: r.text_version, old: r.old_char || undefined, new: r.new_char, note: clean(r.basis) });
    else if (r.kind === 'span') Object.assign(o, { tv: r.text_version, end: r.end, sub: r.sub, old: r.old_text || undefined, new: r.new_text || undefined, note: clean(r.note) });
    else Object.assign(o, { end: r.anchor?.end, ev: r.entity_version, eid: r.entity_id, old: r.text, note: clean(r.note) });
    for (const k of Object.keys(o)) if (o[k] === undefined || o[k] === '') delete o[k];
    return o;
}

/**
 * 快照原文 → 公开清单 JSON 原文：{book, volumes: {<册>: [条目，按格位排]}, threads: {<册>: {<target>: {agree, disagree, replies}}}}。
 * 不带生成时间（内容不变则字节不变，按 md5 跳过上传）。hidden 里的意见、回复不出；表态只出计数。
 */
export function buildPublicFixes(snapshotText, book, threadsText = '', hidden = new Set()) {
    const recs = parseLines(snapshotText).records.filter((r) => r?.book_id === book && fixId(r) && !hidden.has(fixId(r))).sort(cmpFix);
    const volumes = {};
    for (const r of recs) (volumes[r.volume] ||= []).push(toPublicFix(r));
    const threads = {};
    const th = parseLines(threadsText).records
        .filter((r) => r?.book_id === book && threadId(r) && !hidden.has(threadId(r)))
        .sort((x, y) => (x.ts ?? 0) - (y.ts ?? 0) || (threadId(x) < threadId(y) ? -1 : 1));
    for (const r of th) {
        const t = ((threads[r.volume] ||= {})[r.target] ||= { agree: 0, disagree: 0, replies: [] });
        if (r.stance === 'agree') t.agree++;
        else if (r.stance === 'disagree') t.disagree++;
        else t.replies.push({ name: clean(r.name) ?? '', text: clean(r.text) ?? '', ts: r.ts, ...(r.team === true ? { team: true } : {}) });
    }
    const out = { book, volumes };
    if (Object.keys(threads).length) out.threads = threads;
    return JSON.stringify(out, null, 1) + '\n';
}
