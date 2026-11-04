/**
 * 全书总览与跨册聚类审核（/proofing/<书>、/proofing/<书>/c/<聚类>）的数据层。
 *
 * - 每本书一份 `proof/<书>/summary.json`（每日 proofing-sync 生成，规则见 scripts/lib/proofing-summary.mjs）：
 *   每章 rev、待审格数、按待审原因的格数、已投票格数；聚类 = (待审原因, 整理本字)。
 * - 聚类页按聚类里列出的章，逐章取各自的待审单，把同一聚类的格摆在一起；确认走 `/api/cellreview-batch`，
 *   落的票与单格提交同键同形，下游（proofing-sync、cellvotes）不用改。
 */
import { PROOF_BASE, type PendingCell, parsePending, loadCosPending, getAid } from '@/lib/proofing';
import { PENDING_REASONS, parseReason, type PendingReason } from '@/lib/pendingReasons';

export interface SummaryChap { rev: string; n: number; reasons: Record<string, number>; voted?: number }
export interface SummaryCluster { k: string; r: string; c: string; n: number; chaps: Record<string, number> }
export interface BookSummary { book: string; chaps: Record<string, SummaryChap>; clusters: SummaryCluster[] }

const RE_BOOK = /^[\w-]{1,64}$/;
const RE_CHAP = /^[A-Za-z0-9._-]{1,16}$/;
const asObj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const nat = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0);

/** 与 scripts/lib/proofing-summary.mjs 的 clusterChar／clusterKey 同一规则（单测核对） */
export function clusterChar(cell: { ref?: { c?: string }; c?: string }): string {
    for (const v of [cell.ref?.c, cell.c]) if (typeof v === 'string' && [...v].length === 1) return v;
    return '';
}
export const clusterKey = (cell: { pendingReason?: string; ref?: { c?: string }; c?: string }): string => `${parseReason(cell.pendingReason)}~${clusterChar(cell)}`;

/** 聚类键 `<原因>~<字>` → 两部分；格式不对返回 null */
export function parseClusterKey(k: string): { reason: PendingReason; char: string } | null {
    const i = k.indexOf('~');
    if (i < 0) return null;
    const reason = k.slice(0, i);
    const char = k.slice(i + 1);
    if (!Object.prototype.hasOwnProperty.call(PENDING_REASONS, reason) || [...char].length > 1) return null;
    return { reason: reason as PendingReason, char };
}

/** summary.json → BookSummary；坏数据返回 null，不抛 */
export function parseSummary(raw: unknown, book: string): BookSummary | null {
    const o = asObj(raw);
    const chapsRaw = asObj(o?.chaps);
    if (!o || !chapsRaw) return null;
    const chaps: Record<string, SummaryChap> = {};
    for (const [ch, v] of Object.entries(chapsRaw)) {
        const c = asObj(v);
        if (!c || !RE_CHAP.test(ch) || typeof c.rev !== 'string') continue;
        const reasons: Record<string, number> = {};
        for (const [r, n] of Object.entries(asObj(c.reasons) ?? {})) reasons[parseReason(r)] = (reasons[parseReason(r)] ?? 0) + nat(n);
        chaps[ch] = { rev: c.rev, n: nat(c.n), reasons, ...(c.voted !== undefined ? { voted: nat(c.voted) } : {}) };
    }
    const clusters: SummaryCluster[] = [];
    for (const v of Array.isArray(o.clusters) ? o.clusters : []) {
        const c = asObj(v);
        if (!c || typeof c.k !== 'string' || !parseClusterKey(c.k)) continue;
        const cc: Record<string, number> = {};
        for (const [ch, n] of Object.entries(asObj(c.chaps) ?? {})) if (RE_CHAP.test(ch) && nat(n) > 0) cc[ch] = nat(n);
        clusters.push({ k: c.k, r: parseClusterKey(c.k)!.reason, c: parseClusterKey(c.k)!.char, n: nat(c.n), chaps: cc });
    }
    return { book, chaps, clusters };
}

export async function loadSummary(book: string, fetchImpl: typeof fetch = fetch, base = PROOF_BASE): Promise<BookSummary | null> {
    if (!RE_BOOK.test(book)) return null;
    try {
        const res = await fetchImpl(`${base}/${book}/summary.json`);
        return res.ok ? parseSummary(await res.json(), book) : null;
    } catch {
        return null;
    }
}

/** 全书合计：待审总数、已投票数（有的章没写 voted 就当 0，并标 votedKnown=false）、按原因合计、按大类合计 */
export function totals(s: BookSummary): { n: number; voted: number; votedKnown: boolean; byReason: Record<string, number> } {
    let n = 0, voted = 0, votedKnown = true;
    const byReason: Record<string, number> = {};
    for (const c of Object.values(s.chaps)) {
        n += c.n;
        if (c.voted === undefined) { if (c.n > 0) votedKnown = false; } else voted += c.voted;
        for (const [r, k] of Object.entries(c.reasons)) byReason[r] = (byReason[r] ?? 0) + k;
    }
    return { n, voted, votedKnown, byReason };
}

/** 一格带上它所在的章与那份单子的 rev：提交要用 */
export interface ClusterCell { chap: string; rev: string; cell: PendingCell; spriteBase: string }

/** 聚类里列出的各章，逐章取待审单，挑出属于这个聚类的格；取不到的章记在 failed（页面提示，不阻塞别的章） */
export async function loadClusterCells(book: string, key: string, summary: BookSummary, fetchImpl: typeof fetch = fetch, base = PROOF_BASE): Promise<{ cells: ClusterCell[]; failed: string[] }> {
    const cl = summary.clusters.find((c) => c.k === key);
    const cells: ClusterCell[] = [];
    const failed: string[] = [];
    if (!cl) return { cells, failed };
    await Promise.all(Object.keys(cl.chaps).sort().map(async (chap) => {
        const raw = await loadCosPending(book, chap, fetchImpl, base);
        const pd = raw ? parsePending(raw) : null;
        if (!pd?.rev) { failed.push(chap); return; }
        for (const cell of pd.cells) if (clusterKey(cell) === key) cells.push({ chap, rev: pd.rev, cell, spriteBase: `${base}/${book}/${chap}` });
    }));
    cells.sort((x, y) => (x.chap < y.chap ? -1 : x.chap > y.chap ? 1 : 0) || cellCmp(x.cell.a, y.cell.a));
    return { cells, failed: failed.sort() };
}

function cellCmp(a: string, b: string): number {
    const pa = a.match(/^(\d+):(\d+):(\d+)([a-z]?)$/), pb = b.match(/^(\d+):(\d+):(\d+)([a-z]?)$/);
    if (!pa || !pb) return a < b ? -1 : a > b ? 1 : 0;
    for (let i = 1; i <= 3; i++) if (Number(pa[i]) !== Number(pb[i])) return Number(pa[i]) - Number(pb[i]);
    return pa[4] < pb[4] ? -1 : pa[4] > pb[4] ? 1 : 0;
}

// ---- 成批提交 ----

export const BATCH_API = '/api/cellreview-batch';
export const BATCH_MAX = 50;

/** 成批里每一项和单格提交同一套字段：整批确认是 choice=char＋聚类字；挑出来单独处理的可以是别的字、切分有问题（cut，可带字）、看不清（unsure） */
export interface BatchItem { book: string; vol: string; a: string; rev: string; choice: 'char' | 'cut' | 'unsure'; char?: string; note?: string; shown?: string; pick_src?: 'cluster' | 'custom' }
export interface BatchResult { a: string; ok: boolean; error?: string }

/** 成批提交一组（≤ BATCH_MAX）。网络或 5xx 整体重试两次（同键同值重写幂等）；返回逐项结果，整体失败时每项都带同一个错误。不抛 */
export async function submitBatch(items: BatchItem[], fetchImpl: typeof fetch = fetch, retryDelayMs = 1500): Promise<BatchResult[]> {
    const allErr = (error: string): BatchResult[] => items.map((i) => ({ a: i.a, ok: false, error }));
    if (!items.length || items.length > BATCH_MAX) return allErr(`一次最多 ${BATCH_MAX} 格`);
    for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) await new Promise((r) => setTimeout(r, retryDelayMs * attempt));
        try {
            const res = await fetchImpl(BATCH_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ aid: getAid(), items }) });
            if (res.status === 429) return allErr('提交太频繁，请稍后再试');
            let body: { results?: BatchResult[]; error?: string } | null = null;
            try { body = await res.json(); } catch { /* 按状态码给文案 */ }
            if (res.ok && Array.isArray(body?.results) && body!.results!.length === items.length) return body!.results!;
            if (res.status < 500 && res.status !== 0) return allErr(body?.error || `提交失败（${res.status}）`);
        } catch { /* 网络出错，重试 */ }
    }
    return allErr('网络出错或服务器忙，请稍后再试');
}
