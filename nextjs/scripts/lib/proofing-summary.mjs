/**
 * proofing-summary.mjs — 每本书一份「待审总览」proof/<书>/summary.json 的纯函数部分（不连网，单测见同名 .test.mjs）
 *
 * 全书校对总览页（/proofing/<书>）与跨册聚类审核页（/proofing/<书>/c/<聚类>）读它：
 *   chaps    每章的 rev、待审格数 n、按待审原因（pending_reason）的格数 reasons、已有人投票的格数 voted（可选）
 *   clusters 聚类 = (待审原因, 整理本字)：格数 n 与各章分布 chaps。整理本没有字的格取机器读字，都没有则聚类字为空
 * 聚类键 `<原因>~<字>`；与前端 `lib/proofing-cluster.ts` 的 clusterKey 同一规则（单测核对）。
 * 键一律排序、不带时间戳：内容不变则字节不变，可按 md5 跳过上传。
 */

export const CLUSTER_MAX = 800; // 一本书最多列这么多个聚类（按格数从多到少截）
const RE_REASON = /^[a-z][a-z0-9_]{1,40}$/;

/** 待审单一格 → 待审原因（认不出按 unknown，同前端 parseReason 的缺省） */
export function cellReason(cell) {
    const r = cell && (cell.pending_reason ?? cell.pendingReason);
    return typeof r === 'string' && RE_REASON.test(r) ? r : 'unknown';
}

/** 一格的聚类字：整理本字（ref.c）优先，其次机器读字（c）；只认单个字 */
export function clusterChar(cell) {
    for (const v of [cell?.ref?.c, cell?.c]) {
        if (typeof v === 'string' && [...v].length === 1) return v;
    }
    return '';
}

export const clusterKey = (cell) => `${cellReason(cell)}~${clusterChar(cell)}`;

/**
 * @param entries [{book, chap, rev, n, text}]  text 是待审单原文（解析失败的章按 n 记、没有分原因）
 * @param opts {voted: Map<`${book}\0${rev}`, number>}  已投票格数（opinions 段的结果），可空
 * @returns Map<书, JSON 文本>
 */
export function buildSummaries(entries, { voted = new Map() } = {}) {
    const byBook = new Map();
    for (const e of entries) {
        if (!byBook.has(e.book)) byBook.set(e.book, []);
        byBook.get(e.book).push(e);
    }
    const out = new Map();
    for (const [book, list] of [...byBook].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        const revCount = new Map();
        for (const e of list) revCount.set(e.rev, (revCount.get(e.rev) || 0) + 1);
        const chaps = {};
        const clusters = new Map();
        for (const e of [...list].sort((x, y) => (x.chap < y.chap ? -1 : x.chap > y.chap ? 1 : 0))) {
            let cells = [];
            try { const d = JSON.parse(e.text); if (Array.isArray(d?.cells)) cells = d.cells; } catch { /* 坏单只记 n */ }
            const reasons = {};
            for (const c of cells) {
                const r = cellReason(c);
                reasons[r] = (reasons[r] || 0) + 1;
                const k = clusterKey(c);
                const cl = clusters.get(k) || { k, r, c: clusterChar(c), n: 0, chaps: {} };
                cl.n += 1;
                cl.chaps[e.chap] = (cl.chaps[e.chap] || 0) + 1;
                clusters.set(k, cl);
            }
            const sortedReasons = Object.fromEntries(Object.entries(reasons).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
            const v = revCount.get(e.rev) === 1 ? voted.get(`${book}\u0000${e.rev}`) : undefined; // rev 跨章共用时没法分到章，不写
            chaps[e.chap] = { rev: e.rev, n: e.n, reasons: sortedReasons, ...(v !== undefined ? { voted: v } : {}) };
        }
        const cl = [...clusters.values()]
            .sort((a, b) => b.n - a.n || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0))
            .slice(0, CLUSTER_MAX)
            .map((x) => ({ ...x, chaps: Object.fromEntries(Object.entries(x.chaps).sort((p, q) => (p[0] < q[0] ? -1 : 1))) }));
        out.set(book, JSON.stringify({ v: 1, book, chaps, clusters: cl }, null, 1) + '\n');
    }
    return out;
}
