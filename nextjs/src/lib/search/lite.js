// @ts-check
/**
 * L2 轻量分片（S1，2026-09-28）：构建期 Node 与浏览器 Worker 共用。
 *
 * 背景：L2 是 L1（Meili，经 /api/search 代理）挂了才用的浏览器兜底。原先是序列化的
 * MiniSearch 倒排索引（带 20 个展示字段 + 别名），14.7 万条已 52 MB（br 后 7 MB），
 * 条目到 200 万时撑不住。现在只存「id＋书名＋作者（＋朝代）」，浏览器里线性扫描：
 * 14.7 万条一次扫描几毫秒，不需要倒排结构。
 *
 * 分片文件（仍叫 core-{type}[-i].json，meta.json 形状不变，只多 format:'lite'）：
 *   [[id, title, author, dynasty, titleSimplified, authorSimplified], ...]
 *   末尾空串字段省略；简体列只在与原文不同时才写。
 */

import { clean } from './normalize.js';

export const LITE_FORMAT = 'lite';

/**
 * @param {{ id: string, title?: string, author?: string, dynasty?: string,
 *           titleS?: string, authorS?: string }} d
 * @returns {string[]}
 */
export function encodeLiteRow(d) {
    const title = d.title || '';
    const author = d.author || '';
    const row = [
        d.id,
        title,
        author,
        d.dynasty || '',
        d.titleS && d.titleS !== title ? d.titleS : '',
        d.authorS && d.authorS !== author ? d.authorS : '',
    ];
    while (row.length > 1 && row[row.length - 1] === '') row.pop();
    return row;
}

/**
 * @typedef {{ id: string, type: string, title: string, author: string, dynasty: string,
 *             t: string, tS: string, a: string }} LiteDoc
 *   t/tS：规范化后的书名原文／简体（无简体差异时 tS 为 ''）；a：作者原文＋简体（\u0000 分隔）
 */

/**
 * @param {unknown[]} rows
 * @param {string} type
 * @returns {LiteDoc[]}
 */
export function decodeLiteRows(rows, type) {
    /** @type {LiteDoc[]} */
    const out = [];
    for (const r of rows) {
        if (!Array.isArray(r) || typeof r[0] !== 'string') continue;
        const [id, title = '', author = '', dynasty = '', titleS = '', authorS = ''] = /** @type {string[]} */ (r);
        out.push({
            id,
            type,
            title,
            author,
            dynasty,
            t: clean(title),
            tS: titleS ? clean(titleS) : '',
            a: authorS ? `${clean(author)}\u0000${clean(authorS)}` : clean(author),
        });
    }
    return out;
}

/**
 * @param {LiteDoc} d
 * @param {string} term 已 clean
 */
function inTitle(d, term) {
    return d.t.includes(term) || (d.tS !== '' && d.tS.includes(term));
}

/**
 * 书名命中质量：完全相同 > 前缀 > 包含；书名越短越靠前（「史記」排在「史記索隱」前）。
 * @param {LiteDoc} d
 * @param {string} full 整个查询 clean 后
 */
function titleScore(d, full) {
    let s = 0;
    if (d.t === full || d.tS === full) s = 100;
    else if (d.t.startsWith(full) || (d.tS !== '' && d.tS.startsWith(full))) s = 60;
    else if (inTitle(d, full)) s = 40;
    return s + 20 / (1 + Array.from(d.t).length);
}

/**
 * 线性扫描搜索。
 *   1) 严格：按空白切词，每个词都要出现在书名或作者里；
 *   2) 严格 0 命中且查询 ≥3 字：按 bigram 命中数投票，先要求过半、没有再逐层放宽，
 *      与原 MiniSearch 版的 MSM 回退同一口径，容忍一两个字的出入。
 * @param {LiteDoc[]} docs
 * @param {string} query
 * @returns {{ doc: LiteDoc, score: number }[]} 已按分数降序
 */
export function liteSearch(docs, query) {
    const terms = query.split(/\s+/).map(clean).filter(Boolean);
    if (terms.length === 0) return [];
    const full = terms.join('');

    /** @type {{ doc: LiteDoc, score: number }[]} */
    const strict = [];
    for (const d of docs) {
        let authorHits = 0;
        let ok = true;
        for (const term of terms) {
            if (inTitle(d, term)) continue;
            if (d.a.includes(term)) { authorHits++; continue; }
            ok = false;
            break;
        }
        if (!ok) continue;
        strict.push({ doc: d, score: titleScore(d, full) + authorHits * 10 });
    }
    if (strict.length > 0) return sortHits(strict);

    const chars = Array.from(full);
    if (chars.length < 3) return [];
    const bigrams = [...new Set(chars.slice(0, -1).map((c, i) => c + chars[i + 1]))];
    /** @type {{ doc: LiteDoc, n: number }[]} */
    const counted = [];
    for (const d of docs) {
        let n = 0;
        for (const bg of bigrams) if (inTitle(d, bg) || d.a.includes(bg)) n++;
        if (n > 0) counted.push({ doc: d, n });
    }
    // 从「过半」起逐层放宽到 1，取第一个非空层（与旧 MiniSearch 版 MSM 同口径）
    for (let m = Math.max(1, Math.ceil(bigrams.length / 2)); m >= 1; m--) {
        const layer = counted.filter(c => c.n >= m);
        if (layer.length > 0) return sortHits(layer.map(c => ({ doc: c.doc, score: c.n * 100 + titleScore(c.doc, full) })));
    }
    return [];
}

/** @param {{ doc: LiteDoc, score: number }[]} hits */
function sortHits(hits) {
    return hits.sort((x, y) => (y.score - x.score) || (x.doc.t.length - y.doc.t.length));
}
