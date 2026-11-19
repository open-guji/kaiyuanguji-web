'use client';
// 人审页目录：桌面是左侧栏，手机是顶部一条＋底部抽屉。选册＝走链接（客户端跳转），合审是特殊项 `_all`。
// 剩余格数＝总表发布值，扣掉本机已回应的（口径写「约」）；默认只列还有待审的册，可勾「显示已清空的册」。
import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ALL_VOL, readDone, type TocEntry } from '@/lib/proofing';

const href = (book: string, vol: string) => `/proofing/${encodeURIComponent(book)}/${encodeURIComponent(vol)}`;

export interface TocRow extends TocEntry { left: number }

/** 各册剩余＝发布格数 − 本机已回应（不为负） */
export function tocRows(toc: TocEntry[], doneCount: (rev: string) => number, live?: Readonly<Record<string, number>>): TocRow[] {
    // 页面已载入的册用现读的待审单数（答一格就减一格，也认得 KV 里撤下的格）；没载入的册用总表发布值扣本机已答
    return toc.map(e => ({ ...e, left: live?.[e.vol] ?? Math.max(0, e.n - doneCount(e.rev)) }));
}

function List({ book, vol, rows, showAll, onPick, onPickVol }: { book: string; vol: string; rows: TocRow[]; showAll: boolean; onPick?: () => void; onPickVol?: (vol: string) => void }) {
    const [jump, setJump] = useState('');
    const total = rows.reduce((s, r) => s + r.left, 0);
    const openRows = rows.filter(r => r.left > 0 || r.vol === vol);
    const list = (showAll ? rows : openRows).filter(r => !jump.trim() || r.vol.includes(jump.trim()) || r.title.includes(jump.trim()));
    const item = (key: string, to: string, label: string, right: React.ReactNode, cur: boolean, jumpVol?: string) => {
        const cls = 'flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-[14px] no-underline';
        const style = { color: 'var(--color-ink)', backgroundColor: cur ? 'var(--color-tint-2)' : undefined, fontWeight: cur ? 600 : 400 };
        const inner = <><span className="truncate">{label}</span><span className="shrink-0 text-[13px] tabular-nums" style={{ color: 'var(--color-ink-3)' }}>{right}</span></>;
        // 合审里点某册＝滚到该册（不离开合审）；其余是链接
        return (
            <li key={key}>
                {jumpVol !== undefined && onPickVol
                    ? <button type="button" data-testid="toc-item" className={cls} style={style} onClick={() => { onPickVol(jumpVol); onPick?.(); }}>{inner}</button>
                    : <Link href={to} onClick={onPick} aria-current={cur ? 'page' : undefined} data-testid="toc-item" className={cls} style={style}>{inner}</Link>}
            </li>
        );
    };
    return (
        <>
            <input value={jump} onChange={e => setJump(e.target.value)} placeholder="输入册号或名称查找" aria-label="查找册" data-testid="toc-search"
                className="mb-2 w-full rounded border px-2 py-1.5 text-[14px]" style={{ borderColor: 'var(--color-tint-2)', backgroundColor: 'var(--color-paper)' }} />
            <ul className="m-0 list-none p-0">
                {!jump.trim() && item('all', href(book, ALL_VOL), '全部（合审）', total, vol === ALL_VOL)}
                {list.map(r => item(r.vol, href(book, r.vol), r.title, r.left > 0 ? r.left : '✓', r.vol === vol, r.vol))}
                {list.length === 0 && <li className="px-2 py-2 text-[13px]" style={{ color: 'var(--color-ink-3)' }}>没有匹配的册</li>}
            </ul>
        </>
    );
}

export default function ProofToc({ book, vol, toc, onPickVol, live }: { book: string; vol: string; toc: TocEntry[]; onPickVol?: (vol: string) => void; live?: Readonly<Record<string, number>> }) {
    const [counts, setCounts] = useState<Record<string, number>>({});
    const [showAll, setShowAll] = useState(false);
    const [open, setOpen] = useState(false);
    // 本机已回应数只能挂载后读（localStorage）
    useEffect(() => {
        const c: Record<string, number> = {};
        for (const e of toc) c[e.rev] = Object.keys(readDone(e.rev)).length;
        setCounts(c);
    }, [toc, vol]);
    const rows = useMemo(() => tocRows(toc, rev => counts[rev] ?? 0, live), [toc, counts, live]);
    if (!toc.length) return null;
    const total = rows.reduce((s, r) => s + r.left, 0);
    const cur = vol === ALL_VOL ? null : rows.find(r => r.vol === vol);
    const label = vol === ALL_VOL ? '全部（合审）' : cur?.title ?? `册 ${vol}`;
    const right = vol === ALL_VOL ? total : cur?.left ?? 0;
    const toggle = (
        <label className="mt-2 flex cursor-pointer items-center gap-1.5 text-[13px]" style={{ color: 'var(--color-ink-3)' }}>
            <input type="checkbox" checked={showAll} onChange={e => setShowAll(e.target.checked)} data-testid="toc-show-all" /> 显示已清空的册
        </label>
    );
    return (
        <>
            {/* 桌面 */}
            <nav aria-label="册目录" data-testid="proof-toc" className="sticky top-[calc(var(--nav-h)+1rem)] hidden max-h-[calc(100vh-var(--nav-h)-3rem)] w-[188px] shrink-0 self-start overflow-y-auto border-r pr-3 xl:block" style={{ borderColor: 'var(--color-tint-2)' }}>
                <div className="mb-2 text-[12px]" style={{ color: 'var(--color-ink-3)' }}>目录 · 待审约 {total} 格 / {rows.filter(r => r.left > 0).length} 册</div>
                <List book={book} vol={vol} rows={rows} showAll={showAll} onPickVol={onPickVol} />
                {toggle}
            </nav>
            {/* 窄屏：一条＋抽屉 */}
            <div className="mb-3 xl:hidden">
                <button type="button" data-testid="toc-open" onClick={() => setOpen(true)} aria-expanded={open}
                    className="flex w-full items-center justify-between rounded-lg border px-3 py-2 text-[15px]" style={{ borderColor: 'var(--color-tint-2)', backgroundColor: 'var(--color-raise)', color: 'var(--color-ink)' }}>
                    <span>▾ <b>{label}</b></span><span style={{ color: 'var(--color-ink-3)' }}>剩约 {right} 格</span>
                </button>
                {open && (
                    <div className="fixed inset-0 z-50" role="dialog" aria-label="选择册">
                        <div className="absolute inset-0 bg-black/40" onClick={() => setOpen(false)} />
                        <div className="absolute inset-x-0 bottom-0 top-24 overflow-y-auto rounded-t-2xl p-4" style={{ backgroundColor: 'var(--color-paper)' }}>
                            <div className="mb-2 flex items-center justify-between"><b>选择册</b><button type="button" onClick={() => setOpen(false)} aria-label="关闭" className="px-2 text-[20px]">×</button></div>
                            <List book={book} vol={vol} rows={rows} showAll={showAll} onPick={() => setOpen(false)} onPickVol={onPickVol} />
                            {toggle}
                        </div>
                    </div>
                )}
            </div>
        </>
    );
}
