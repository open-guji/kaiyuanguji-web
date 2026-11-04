'use client';

// 总览页的「成批校对」：每个字一行，直接摆出这个字的各格小图，缺省全选；点一格挑出（不确认），
// 每行可以单独确认，页底一个按钮把本页所有行选中的格一起确认。挑出的格留在单子上，进聚类页逐格看。
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { shownZi } from '@/lib/zi-display';
import { readDone, writeDone, type DoneMap } from '@/lib/proofing';
import { PENDING_REASONS, parseReason } from '@/lib/pendingReasons';
import ClusterTile from '@/components/proof/ClusterTile';
import { confirmCells, isBatchReason, summaryCells, type BookSummary, type ClusterCell, type SummaryCluster } from '@/lib/proofing-cluster';

/** 一次摆几行、每行最多几格（再多的进聚类页） */
export const BOARD_ROWS = 8;
export const ROW_CELLS = 24;

const ink = 'var(--color-ink)', ink2 = 'var(--color-ink-2)', ink3 = 'var(--color-ink-3)', tint = 'var(--color-tint-2)';
const BTN: React.CSSProperties = { border: '1px solid #b8ad9a', borderRadius: 6, background: '#fff', color: '#333', cursor: 'pointer', padding: '3px 10px', fontSize: 13, lineHeight: 1.4 };
const BTN_PRIMARY: React.CSSProperties = { ...BTN, background: '#7a3b1d', borderColor: '#7a3b1d', color: '#fff', fontSize: 15, padding: '5px 14px' };

const cid = (c: ClusterCell) => `${c.chap}/${c.cell.a}`;

interface Row { cl: SummaryCluster; cells: ClusterCell[]; more: number }

/** 可在总览直接确认的行：原因在 BATCH_REASONS、summary 带了格、去掉本机已处理过的；按剩余格数从多到少 */
export function boardRows(book: string, s: BookSummary, done: Record<string, DoneMap>, catFilter: string | null): Row[] {
    const rows: Row[] = [];
    for (const cl of s.clusters) {
        if (!isBatchReason(cl.r) || !cl.c || !cl.cells?.length) continue;
        if (catFilter && PENDING_REASONS[parseReason(cl.r)].category !== catFilter) continue;
        const open = summaryCells(book, cl, s).filter(c => !done[c.rev]?.[c.cell.a]);
        if (!open.length) continue;
        rows.push({ cl, cells: open.slice(0, ROW_CELLS), more: Math.max(0, open.length - ROW_CELLS) });
    }
    return rows.sort((a, b) => b.cells.length + b.more - (a.cells.length + a.more));
}

function BoardRow({ book, row, out, busy, onToggle, onAll, onConfirm }: {
    book: string; row: Row; out: Set<string>; busy: boolean;
    onToggle: (c: ClusterCell) => void; onAll: (pick: boolean) => void; onConfirm: () => void;
}) {
    const { cl, cells, more } = row;
    const n = cells.filter(c => !out.has(cid(c))).length;
    const picked = cells.length - n;
    const sp = PENDING_REASONS[parseReason(cl.r)];
    return (
        <li data-testid="board-row" className="rounded-lg p-3" style={{ border: `1px solid ${tint}`, listStyle: 'none' }}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span data-testid="board-char" className="text-[34px] leading-none" style={{ fontFamily: 'var(--font-serif)', color: ink }}>{shownZi(cl.c)}</span>
                <span className="text-[13px]" style={{ color: ink2 }}>{sp.label} · <b className="tabular-nums" style={{ color: ink }}>{cells.length + more}</b> 格 · {Object.keys(cl.chaps).length} 册</span>
                <span className="flex-1" />
                <button type="button" style={BTN} disabled={busy} onClick={() => onAll(picked === 0)}>{picked === 0 ? '全部挑出' : '全部放回'}</button>
                <button type="button" data-testid="board-row-confirm" style={{ ...BTN_PRIMARY, opacity: busy || !n ? 0.45 : 1 }} disabled={busy || !n} onClick={onConfirm}>
                    确认这 {n} 格是「{shownZi(cl.c)}」
                </button>
            </div>
            <ul className="m-0 mt-2 grid p-0" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(72px, 1fr))', gap: 5 }}>
                {cells.map(c => <ClusterTile key={cid(c)} c={c} on={out.has(cid(c))} busy={busy} onToggle={() => onToggle(c)} box={60} />)}
            </ul>
            {(picked > 0 || more > 0) && (
                <p className="m-0 mt-1 text-[12px]" style={{ color: ink3 }}>
                    {picked > 0 && <>挑出的 {picked} 格不确认，留在单子上。</>}
                    {more > 0 && <>后面还有 {more} 格，确认完这些自动补上。</>}
                    {' '}<Link href={`/proofing/${book}/c/${encodeURIComponent(cl.k)}`} className="underline">逐格看这个字</Link>
                </p>
            )}
        </li>
    );
}

export default function BatchBoard({ book, s, catFilter }: { book: string; s: BookSummary; catFilter: string | null }) {
    const [done, setDone] = useState<Record<string, DoneMap>>({});
    useEffect(() => {
        const m: Record<string, DoneMap> = {};
        for (const c of Object.values(s.chaps)) if (!m[c.rev]) m[c.rev] = readDone(c.rev);
        setDone(m);
    }, [s]);
    const rows = useMemo(() => boardRows(book, s, done, catFilter), [book, s, done, catFilter]);
    const shown = rows.slice(0, BOARD_ROWS);
    // 挑出的格（键：聚类键|章/格位）。确认后挑出的格还在单子上，本次浏览里一直记着
    const [out, setOut] = useState<Record<string, Set<string>>>({});
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<{ ok: number; err: string | null } | null>(null);
    const outOf = useCallback((k: string) => out[k] ?? new Set<string>(), [out]);

    const confirmRows = async (rs: Row[]) => {
        setBusy(true); setMsg(null);
        let okN = 0, err: string | null = null;
        const sent: ClusterCell[] = [];
        for (const r of rs) {
            const cells = r.cells.filter(c => !outOf(r.cl.k).has(cid(c)));
            if (!cells.length) continue;
            const res = await confirmCells(book, r.cl.c, cells);
            sent.push(...res.ok);
            okN += res.ok.length;
            err ??= res.err;
            if (res.err && !res.ok.length) break;
        }
        if (sent.length) {
            setDone(prev => {
                const next = { ...prev };
                for (const c of sent) next[c.rev] = { ...(next[c.rev] ?? {}), [c.cell.a]: `「${c.cell.ref?.c ?? ''}」` };
                for (const rev of new Set(sent.map(c => c.rev))) writeDone(rev, next[rev]);
                return next;
            });
        }
        setBusy(false);
        setMsg({ ok: okN, err });
    };

    if (!rows.length) return null;
    const total = shown.reduce((n, r) => n + r.cells.filter(c => !outOf(r.cl.k).has(cid(c))).length, 0);
    // 挑出的格一直显示：一行只剩挑出的格时不算「可确认」，但行还在，免得以为丢了
    return (
        <section data-testid="batch-board">
            <h2 className="m-0 mb-1 mt-8 text-[18px] font-semibold" style={{ color: ink }}>成批校对</h2>
            <p className="m-0 mb-3 text-[14px]" style={{ color: ink2 }}>
                这些字只看图就能定，同一个字跨册排在一起，缺省全选。看一眼，不像的点一下挑出来，再确认。挑出的格留在单子上，以后逐格看。
                全书可成批的还有 {rows.length} 个字，本页先摆 {shown.length} 个。
            </p>
            <ul className="m-0 flex flex-col gap-3 p-0">
                {shown.map(r => (
                    <BoardRow key={r.cl.k} book={book} row={r} out={outOf(r.cl.k)} busy={busy}
                        onToggle={c => setOut(p => { const s2 = new Set(p[r.cl.k] ?? []); if (s2.has(cid(c))) s2.delete(cid(c)); else s2.add(cid(c)); return { ...p, [r.cl.k]: s2 }; })}
                        onAll={pick => setOut(p => ({ ...p, [r.cl.k]: pick ? new Set(r.cells.map(cid)) : new Set() }))}
                        onConfirm={() => confirmRows([r])} />
                ))}
            </ul>
            <div className="sticky bottom-0 mt-3 flex flex-wrap items-center gap-3 py-3" style={{ background: 'var(--color-paper, #faf7f2)', borderTop: `1px solid ${tint}` }}>
                <button type="button" data-testid="board-confirm-all" style={{ ...BTN_PRIMARY, opacity: busy || !total ? 0.45 : 1 }} disabled={busy || !total} onClick={() => confirmRows(shown)}>
                    确认本页全部选中的 {total} 格（{shown.length} 个字）
                </button>
                {busy && <span className="text-[13px]" style={{ color: ink3 }}>正在提交……</span>}
                {msg && !busy && <span role={msg.err ? 'alert' : 'status'} className="text-[13px]" style={{ color: msg.err ? '#c33' : '#1b6b44' }}>
                    {msg.err ? `交上 ${msg.ok} 格，其余没交上：${msg.err}` : `交上 ${msg.ok} 格，谢谢！`}
                </span>}
            </div>
        </section>
    );
}
