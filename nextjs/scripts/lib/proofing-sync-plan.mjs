/**
 * proofing-sync-plan.mjs — 每日「proofing-sync」的纯函数部分（不连网，单测见同名 .test.mjs）
 *
 * 设计：ai-team `team/整理/设计/待审单与公众意见走中心库.md` 块 C。
 *   中心库 files 表里：
 *   待审条目只在库表里（Worker /v1/web/pending-chapters 汇总各章与单格图登记），没有 rev、没有整张单
 *     feedback/lists/web/<书>/items.jsonl              网站意见快照（本任务写入，按 (item, voter) 排序）
 *   COS：[前缀/]proof/<书>/<章>/<图名>                 条目里登记的单格图（雪碧图），网站精校页按条目读
 */
import { createHash } from 'node:crypto';

export const WEB_PREFIX = 'feedback/lists/web/';

const RE_BOOK = /^[0-9a-z]{4,24}$/; // 与 edge-functions/api/cellreview.js 同

/**
 * 总索引 proof/index.json：{books: {<书>: {<章>: {n}}}}，n＝开着的条目数（发站时的静态值，页面再用现算的盖掉；没有 rev）。
 * 键一律排序、不带时间戳，内容不变则字节不变，可按 md5 跳过。
 * @param entries [{book, chap, n}]
 */
export function buildProofIndex(entries) {
    const books = {};
    const sorted = [...entries].sort((x, y) => (x.book < y.book ? -1 : x.book > y.book ? 1 : x.chap < y.chap ? -1 : x.chap > y.chap ? 1 : 0));
    for (const e of sorted) (books[e.book] ||= {})[e.chap] = { n: e.n };
    return JSON.stringify({ books }, null, 2) + '\n';
}

/** only 发布用：在 COS 现有 index.json 上只改 picked 那几章，别的章原样保留（旧文件里的 rev 一并丢掉）。 */
export function mergeProofIndex(oldText, picked) {
    const books = {};
    for (const [b, chaps] of Object.entries(JSON.parse(oldText)?.books || {})) {
        books[b] = {};
        for (const [c, m] of Object.entries(chaps)) books[b][c] = { n: m?.n ?? 0 };
    }
    for (const e of picked) (books[e.book] ||= {})[e.chap] = { n: e.n };
    const out = {};
    for (const b of Object.keys(books).sort()) {
        out[b] = {};
        for (const c of Object.keys(books[b]).sort()) out[b][c] = books[b][c];
    }
    return JSON.stringify({ books: out }, null, 2) + '\n';
}

/** 一条意见规整成固定键序（同内容 → 同字节） */
// pick_src／pick_rank／pivot：选的字从哪儿点来（相似字效果的量数，人审找字 §5.3）；旧票没有，快照字节不变
// alt：choice=figure（是图形，不是字）时的图形说明（char v0.3，GUJI-742）；别的票没有，快照字节不变
const RECORD_KEYS = ['v', 'book', 'vol', 'a', 'rev', 'item', 'ver', 'choice', 'char', 'alt', 'note', 'shown', 'pick_src', 'pick_rank', 'pivot', 'voter', 'iph', 'ts'];
export function normalizeRecord(r) {
    const out = {};
    for (const k of RECORD_KEYS) if (r[k] !== undefined && r[k] !== null && !(k === 'char' && r[k] === '')) out[k] = r[k];
    return out;
}

/** 坐标 页:列:格[ab] 按数值排，同格 a 在 b 前 */
export function cellOrder(a, b) {
    const pa = String(a).match(/^(\d+):(\d+):(-?\d+)([ab]?)$/);
    const pb = String(b).match(/^(\d+):(\d+):(-?\d+)([ab]?)$/);
    if (!pa || !pb) return a < b ? -1 : a > b ? 1 : 0;
    for (let i = 1; i <= 3; i++) {
        const d = Number(pa[i]) - Number(pb[i]);
        if (d) return d;
    }
    return pa[4] < pb[4] ? -1 : pa[4] > pb[4] ? 1 : 0;
}

/** 快照 jsonl 原文 → 记录数组（坏行跳过，计数返回） */
export function parseSnapshot(text) {
    const records = [];
    let bad = 0;
    for (const line of (text || '').split('\n')) {
        if (!line.trim()) continue;
        try { records.push(JSON.parse(line)); } catch { bad++; }
    }
    return { records, bad };
}

/** 按条目记的票（待审条目化，sheldon 11-10）在中心库的快照：一书一份 */
export function itemSnapshotPath(book) {
    if (!RE_BOOK.test(book)) throw new Error(`book 无效：${book}`);
    return `${WEB_PREFIX}${book}/items.jsonl`;
}

const RE_ITEM = /^pi_[0-9a-f]{12}$/;

/**
 * 按条目记的票合成新快照：旧快照 ∪ KV 现有票，同 (item, voter) 以 KV 为准；KV 过期的旧票保留。
 * 排序按 (item, voter)，同内容同字节。
 */
export function mergeItemSnapshot(oldText, kvItems, { book }) {
    const byKey = new Map();
    const ok = (r) => r && r.book === book && typeof r.item === 'string' && RE_ITEM.test(r.item) && typeof r.voter === 'string';
    for (const r of parseSnapshot(oldText).records) if (ok(r)) byKey.set(`${r.item}\u0000${r.voter}`, normalizeRecord(r));
    const oldKeys = new Set(byKey.keys());
    let added = 0, updated = 0, dropped = 0;
    const seen = new Set();
    for (const raw of kvItems || []) {
        if (!ok(raw)) { dropped++; continue; }
        const k = `${raw.item}\u0000${raw.voter}`;
        const rec = normalizeRecord(raw);
        const prev = byKey.get(k);
        if (!prev) added++;
        else if (JSON.stringify(prev) !== JSON.stringify(rec)) updated++;
        byKey.set(k, rec);
        seen.add(k);
    }
    const kept = [...oldKeys].filter((k) => !seen.has(k)).length;
    const all = [...byKey.entries()].sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)).map((e) => e[1]);
    const text = all.map((r) => JSON.stringify(r)).join('\n') + (all.length ? '\n' : '');
    return { text, total: all.length, cells: new Set(all.map((r) => r.item)).size, added, updated, kept, dropped };
}

export const md5Hex = (s) => createHash('md5').update(s).digest('hex');

/**
 * 要传到 COS 的对象：内容 md5 与 COS ETag 相同的跳过。
 * @param objects [{key, body}]（key 相对 proof/ 前缀）
 * @param remote Map<key, etag>
 */
export function planCosPut(objects, remote) {
    const put = [], same = [];
    for (const o of objects) (remote.get(o.key) === md5Hex(o.body) ? same : put).push(o);
    return { put, same };
}
