/**
 * proofing-sync-plan.mjs — 每日「proofing-sync」的纯函数部分（不连网，单测见同名 .test.mjs）
 *
 * 设计：ai-team `team/整理/设计/待审单与公众意见走中心库.md` 块 C。
 *   中心库 files 表里：
 *     feedback/lists/proofing/<书>/<章>.pending.json   待审单（整理导出写入）
 *     feedback/lists/web/<书>/<rev>.jsonl              网站意见快照（本任务写入，一行一票，按 (a, voter) 排序）
 *   COS：[前缀/]proof/index.json、[前缀/]proof/<书>/<章>.pending.json
 */
import { createHash } from 'node:crypto';

export const PROOFING_PREFIX = 'feedback/lists/proofing/';
export const WEB_PREFIX = 'feedback/lists/web/';

const RE_BOOK = /^[0-9a-z]{4,24}$/; // 与 edge-functions/api/cellreview.js 同
const RE_CHAP = /^[A-Za-z0-9._-]{1,16}$/;
const RE_REV = /^[A-Za-z0-9._-]{1,64}$/;

/** `feedback/lists/proofing/<书>/<章>.pending.json` → {book, chap}；不是这个形状返回 null */
export function parsePendingPath(srcPath) {
    if (typeof srcPath !== 'string' || !srcPath.startsWith(PROOFING_PREFIX)) return null;
    const rest = srcPath.slice(PROOFING_PREFIX.length).split('/');
    if (rest.length !== 2) return null;
    const [book, file] = rest;
    const m = /^(.+)\.pending\.json$/.exec(file);
    if (!m || !RE_BOOK.test(book) || !RE_CHAP.test(m[1])) return null;
    return { book, chap: m[1] };
}

/** 意见快照在中心库的路径 */
export function webSnapshotPath(book, rev) {
    if (!RE_BOOK.test(book)) throw new Error(`book 无效：${book}`);
    if (!RE_REV.test(rev)) throw new Error(`rev 无效：${rev}`);
    return `${WEB_PREFIX}${book}/${rev}.jsonl`;
}

/**
 * 解析一份待审单原文。要 rev（字符串）与 cells（数组）；不合格返回 {error}。
 * @returns {{rev: string, n: number} | {error: string}}
 */
export function readPending(text) {
    let doc;
    try { doc = JSON.parse(text); } catch { return { error: '不是合法 JSON' }; }
    if (!doc || typeof doc !== 'object') return { error: '顶层不是对象' };
    if (typeof doc.rev !== 'string' || !RE_REV.test(doc.rev)) return { error: 'rev 缺失或不合法' };
    if (!Array.isArray(doc.cells)) return { error: 'cells 不是数组' };
    return { rev: doc.rev, n: doc.cells.length };
}

/**
 * 网站读的总索引：{books: {<书>: {<章>: {rev, n}}}}，键一律排序，不带时间戳（内容不变则字节不变，可按 md5 跳过）。
 * @param entries [{book, chap, rev, n}]
 */
export function buildProofIndex(entries) {
    const books = {};
    const sorted = [...entries].sort((x, y) => (x.book < y.book ? -1 : x.book > y.book ? 1 : x.chap < y.chap ? -1 : x.chap > y.chap ? 1 : 0));
    for (const e of sorted) {
        (books[e.book] ||= {})[e.chap] = { rev: e.rev, n: e.n };
    }
    return JSON.stringify({ books }, null, 2) + '\n';
}

/** 一条意见规整成固定键序（同内容 → 同字节） */
const RECORD_KEYS = ['v', 'book', 'vol', 'a', 'rev', 'choice', 'char', 'note', 'shown', 'voter', 'iph', 'ts'];
export function normalizeRecord(r) {
    const out = {};
    for (const k of RECORD_KEYS) if (r[k] !== undefined && r[k] !== null && !(k === 'char' && r[k] === '')) out[k] = r[k];
    return out;
}

function cmpVote(x, y) {
    if (x.a !== y.a) return cellOrder(x.a, y.a);
    return x.voter < y.voter ? -1 : x.voter > y.voter ? 1 : 0;
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

/**
 * 合成新快照：旧快照 ∪ KV 现有票，同 (a, voter) 以 KV 为准（重投覆盖）。
 * KV 有 60 天 TTL，过期的票 KV 里没了但票仍算数，所以旧快照里有、KV 里没有的保留，不删。
 * 只收 book、rev 对得上的记录。
 * @returns {{text: string, total: number, added: number, updated: number, kept: number, dropped: number}}
 */
export function mergeSnapshot(oldText, kvItems, { book, rev }) {
    const byKey = new Map();
    const { records: old } = parseSnapshot(oldText);
    for (const r of old) {
        if (r && r.book === book && r.rev === rev && typeof r.a === 'string' && typeof r.voter === 'string') {
            byKey.set(`${r.a}\u0000${r.voter}`, normalizeRecord(r));
        }
    }
    const oldKeys = new Set(byKey.keys());
    let added = 0, updated = 0, dropped = 0;
    for (const raw of kvItems || []) {
        if (!raw || raw.book !== book || raw.rev !== rev || typeof raw.a !== 'string' || typeof raw.voter !== 'string') { dropped++; continue; }
        const k = `${raw.a}\u0000${raw.voter}`;
        const rec = normalizeRecord(raw);
        const prev = byKey.get(k);
        if (!prev) added++;
        else if (JSON.stringify(prev) !== JSON.stringify(rec)) updated++;
        byKey.set(k, rec);
    }
    const seen = new Set((kvItems || []).filter((r) => r && r.book === book && r.rev === rev).map((r) => `${r.a}\u0000${r.voter}`));
    const kept = [...oldKeys].filter((k) => !seen.has(k)).length;
    const all = [...byKey.values()].sort(cmpVote);
    const text = all.map((r) => JSON.stringify(r)).join('\n') + (all.length ? '\n' : '');
    return { text, total: all.length, added, updated, kept, dropped };
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
