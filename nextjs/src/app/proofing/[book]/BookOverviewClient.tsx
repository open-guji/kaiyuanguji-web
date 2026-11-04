'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import LayoutWrapper from '@/components/layout/LayoutWrapper';
import ProofHeader, { type ProofBookInfo } from '@/components/proof/ProofHeader';
import { readerPath } from '@/lib/reader-route';
import { shownZi } from '@/lib/zi-display';
import { PENDING_REASONS, REASON_CATEGORIES, REASON_ROUTES, parseReason } from '@/lib/pendingReasons';
import { loadSummary, totals, type BookSummary } from '@/lib/proofing-cluster';

const CLUSTER_SHOW = 36;
const ink = 'var(--color-ink)', ink2 = 'var(--color-ink-2)', ink3 = 'var(--color-ink-3)', tint = 'var(--color-tint-2)', zhu = 'var(--color-zhu)';

/** 待审原因 → 大类；大类下按格数从多到少列原因 */
export function groupByCategory(byReason: Record<string, number>): { cat: string; name: string; n: number; reasons: { reason: string; n: number }[] }[] {
    const m = new Map<string, { reason: string; n: number }[]>();
    for (const [r, n] of Object.entries(byReason)) {
        if (n <= 0) continue;
        const cat = PENDING_REASONS[parseReason(r)].category;
        m.set(cat, [...(m.get(cat) ?? []), { reason: parseReason(r), n }]);
    }
    return [...m].map(([cat, reasons]) => ({
        cat, name: REASON_CATEGORIES[cat] ?? cat, reasons: reasons.sort((a, b) => b.n - a.n), n: reasons.reduce((s, x) => s + x.n, 0),
    })).sort((a, b) => b.n - a.n);
}

/** 一章按大类的格数 */
export function chapByCategory(reasons: Record<string, number>): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [r, n] of Object.entries(reasons)) { const c = PENDING_REASONS[parseReason(r)].category; out[c] = (out[c] ?? 0) + n; }
    return out;
}

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
    return (
        <div className="min-w-[8rem]">
            <div className="text-[13px]" style={{ color: ink3 }}>{label}</div>
            <div className="text-[28px] font-semibold leading-tight" style={{ color: ink }}>{value}</div>
            {sub && <div className="text-[12px]" style={{ color: ink3 }}>{sub}</div>}
        </div>
    );
}

function Overview({ book, s }: { book: string; s: BookSummary }) {
    const t = useMemo(() => totals(s), [s]);
    const cats = useMemo(() => groupByCategory(t.byReason), [t]);
    const chaps = useMemo(() => Object.entries(s.chaps).sort((a, b) => (a[0] < b[0] ? -1 : 1)), [s]);
    const openChaps = chaps.filter(([, c]) => c.n > 0).length;
    const max = Math.max(1, ...cats.map(c => c.n));
    const catCols = cats.map(c => c.cat);
    const cellMax = Math.max(1, ...chaps.flatMap(([, c]) => Object.values(chapByCategory(c.reasons))));
    // 可成批审的聚类：只收「要选字」的原因（页面是选字的），至少 2 格才值得成批
    const [catFilter, setCatFilter] = useState<string | null>(null);
    const clusters = useMemo(() => s.clusters.filter(c => c.n >= 2 && PENDING_REASONS[parseReason(c.r)].ui === 'pick' && c.c
        && (!catFilter || PENDING_REASONS[parseReason(c.r)].category === catFilter)), [s, catFilter]);
    return (
        <div className="mx-auto max-w-[1100px] px-4 pb-16 pt-5">
            <section data-testid="overview-stats" className="flex flex-wrap gap-x-10 gap-y-4 rounded-lg p-4 sm:p-5" style={{ backgroundColor: 'var(--color-raise)', border: `1px solid ${tint}` }}>
                <Stat label="还有待选的字" value={<>{t.n.toLocaleString()} <span className="text-[15px] font-normal" style={{ color: ink2 }}>格</span></>} sub={`分布在 ${openChaps} 册`} />
                {t.votedKnown && <Stat label="已有人点过" value={<>{t.voted.toLocaleString()} <span className="text-[15px] font-normal" style={{ color: ink2 }}>格</span></>} sub={t.n ? `占待选的 ${Math.round((100 * t.voted) / t.n)}%，等整理组落票后从单子里去掉` : undefined} />}
                <Stat label="待选原因" value={<>{cats.length} <span className="text-[15px] font-normal" style={{ color: ink2 }}>大类</span></>} sub={`${Object.keys(t.byReason).length} 种具体原因`} />
            </section>

            <h2 className="m-0 mb-1 mt-8 text-[18px] font-semibold" style={{ color: ink }}>都是什么原因</h2>
            <p className="m-0 mb-3 text-[14px]" style={{ color: ink2 }}>点一个大类，只看这类的聚类和册。</p>
            <ul data-testid="overview-categories" className="m-0 flex list-none flex-col gap-2 p-0">
                {cats.map(c => (
                    <li key={c.cat} className="rounded-lg p-3" style={{ border: `1px solid ${tint}`, background: catFilter === c.cat ? 'var(--color-zhu-tint)' : 'transparent' }}>
                        <button type="button" aria-pressed={catFilter === c.cat} onClick={() => setCatFilter(catFilter === c.cat ? null : c.cat)}
                            className="flex w-full cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 border-0 bg-transparent p-0 text-left">
                            <span className="w-28 shrink-0 text-[16px] font-semibold" style={{ color: ink }}>{c.name}</span>
                            <span className="h-3 min-w-[3rem] flex-1 overflow-hidden rounded-full" style={{ backgroundColor: tint }} aria-hidden="true">
                                <span className="block h-full rounded-full" style={{ width: `${Math.max(2, (100 * c.n) / max)}%`, backgroundColor: zhu }} />
                            </span>
                            <span className="w-24 shrink-0 text-right text-[16px] tabular-nums" style={{ color: ink }}>{c.n.toLocaleString()} 格</span>
                        </button>
                        <ul className="m-0 mt-2 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-[13px]" style={{ color: ink2 }}>
                            {c.reasons.map(r => {
                                const sp = PENDING_REASONS[parseReason(r.reason)];
                                return <li key={r.reason} title={`${sp.hint}（${REASON_ROUTES[sp.route] ?? ''}）`}>{sp.label} <b className="tabular-nums" style={{ color: ink }}>{r.n}</b></li>;
                            })}
                        </ul>
                    </li>
                ))}
                {!cats.length && <li className="text-[15px]" style={{ color: ink2 }}>这本书现在没有待选的字，都校完了，谢谢！</li>}
            </ul>

            {clusters.length > 0 && (
                <>
                    <h2 className="m-0 mb-1 mt-8 text-[18px] font-semibold" style={{ color: ink }}>成批校对</h2>
                    <p className="m-0 mb-3 text-[14px]" style={{ color: ink2 }}>同一原因、同一个字的待选格跨册排在一起，一次看完、一次确认。按格数从多到少排。</p>
                    <ul data-testid="overview-clusters" className="m-0 grid list-none gap-2 p-0" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))' }}>
                        {clusters.slice(0, CLUSTER_SHOW).map(c => (
                            <li key={c.k}>
                                <Link href={`/proofing/${book}/c/${encodeURIComponent(c.k)}`} className="flex items-center gap-3 rounded-lg p-2 no-underline hover:brightness-95"
                                    style={{ border: `1px solid ${tint}`, color: ink }} data-testid="cluster-link">
                                    <span className="text-[30px] leading-none" style={{ fontFamily: 'var(--font-serif)' }}>{shownZi(c.c)}</span>
                                    <span className="min-w-0 text-[13px] leading-snug">
                                        <span className="block" style={{ color: ink2 }}>{PENDING_REASONS[parseReason(c.r)].label}</span>
                                        <span className="block tabular-nums"><b>{c.n}</b> 格 · {Object.keys(c.chaps).length} 册</span>
                                    </span>
                                </Link>
                            </li>
                        ))}
                    </ul>
                    {clusters.length > CLUSTER_SHOW && <p className="mt-2 text-[13px]" style={{ color: ink3 }}>还有 {clusters.length - CLUSTER_SHOW} 个格数更少的聚类，先把上面的审完。</p>}
                </>
            )}

            <h2 className="m-0 mb-1 mt-8 text-[18px] font-semibold" style={{ color: ink }}>每册还剩多少</h2>
            <p className="m-0 mb-3 text-[14px]" style={{ color: ink2 }}>点册号进这一册，逐格看。颜色越深，这一类越多。</p>
            <div className="overflow-x-auto">
                <table data-testid="overview-matrix" className="w-full border-collapse text-[13px]" style={{ color: ink }}>
                    <thead>
                        <tr style={{ borderBottom: `1px solid ${tint}` }}>
                            <th className="px-2 py-1 text-left font-medium">册</th>
                            <th className="px-2 py-1 text-right font-medium">待选</th>
                            {cats.map(c => <th key={c.cat} className="px-2 py-1 text-right font-medium" style={catFilter && catFilter !== c.cat ? { opacity: 0.4 } : undefined}>{c.name}</th>)}
                        </tr>
                    </thead>
                    <tbody>
                        {chaps.map(([ch, c]) => {
                            const bc = chapByCategory(c.reasons);
                            return (
                                <tr key={ch} style={{ borderBottom: `1px solid ${tint}` }}>
                                    <td className="px-2 py-1"><Link href={`/proofing/${book}/${ch}`} className="underline">{ch}</Link></td>
                                    <td className="px-2 py-1 text-right tabular-nums">{c.n}</td>
                                    {catCols.map(cat => {
                                        const n = bc[cat] ?? 0;
                                        return <td key={cat} className="px-2 py-1 text-right tabular-nums"
                                            style={{ background: n ? `color-mix(in srgb, var(--color-zhu) ${Math.round(8 + (62 * n) / cellMax)}%, transparent)` : undefined, opacity: catFilter && catFilter !== cat ? 0.4 : 1 }}>{n || ''}</td>;
                                    })}
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
            <p className="m-0 mt-6 text-[13px]" style={{ color: ink3 }}>数字每天更新一次。不用登录，意见匿名收集，供整理时参考。</p>
        </div>
    );
}

export default function BookOverviewClient({ book, info = null }: { book: string; info?: ProofBookInfo | null }) {
    const [state, setState] = useState<'loading' | 'none' | 'ok'>('loading');
    const [summary, setSummary] = useState<BookSummary | null>(null);
    useEffect(() => {
        let cancelled = false;
        loadSummary(book).then(s => { if (cancelled) return; setSummary(s); setState(s ? 'ok' : 'none'); });
        return () => { cancelled = true; };
    }, [book]);
    return (
        <LayoutWrapper hideFooter>
            <ProofHeader back={readerPath(book)} info={info} sub="校对总览" badge="校对中" />
            {state === 'loading' && <p role="status" className="mx-auto max-w-[1100px] px-4 py-8 text-[15px]" style={{ color: ink2 }}>正在读取……</p>}
            {state === 'none' && <p role="status" className="mx-auto max-w-[1100px] px-4 py-8 text-[15px]" style={{ color: ink2 }}>这本书的校对名单还没有发布，请稍后再来。</p>}
            {state === 'ok' && summary && <Overview book={book} s={summary} />}
        </LayoutWrapper>
    );
}
