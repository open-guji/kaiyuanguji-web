'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import LayoutWrapper from '@/components/layout/LayoutWrapper';
import ProofHeader, { type ProofBookInfo } from '@/components/proof/ProofHeader';
import { readerPath } from '@/lib/reader-route';
import { canShow, cpLabel, shownZi } from '@/lib/zi-display';
import { readDone, writeDone, type DoneMap } from '@/lib/proofing';
import { PENDING_REASONS } from '@/lib/pendingReasons';
import {
    BATCH_MAX, loadClusterCells, loadSummary, parseClusterKey, submitBatch, type BatchItem, type ClusterCell,
} from '@/lib/proofing-cluster';

const PAGE = 30; // 一次摆多少格（与逐册页的快速确认一致）
const ink = 'var(--color-ink)', ink2 = 'var(--color-ink-2)', ink3 = 'var(--color-ink-3)', tint = 'var(--color-tint-2)';
const BTN: React.CSSProperties = { border: '1px solid #b8ad9a', borderRadius: 6, background: '#fff', color: '#333', cursor: 'pointer', padding: '3px 10px', fontSize: 14, lineHeight: 1.4, boxShadow: '0 1px 0 rgba(0,0,0,0.06)' };
const BTN_PRIMARY: React.CSSProperties = { ...BTN, background: '#7a3b1d', borderColor: '#7a3b1d', color: '#fff', fontSize: 16, padding: '6px 18px' };

const cid = (c: ClusterCell) => `${c.chap}/${c.cell.a}`;
const place = (a: string) => { const m = /^(\d+):(\d+):(\d+)([a-z]?)$/.exec(a); return m ? `${Number(m[1])} 叶 ${Number(m[2])} 列 ${Number(m[3])} 字${m[4] ? (m[4] === 'a' ? '（夹注右）' : '（夹注左）') : ''}` : a; };

function Zi({ c }: { c: string }) {
    if (canShow(c)) return <>{c}</>;
    return <span title={c} style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: '0.55em' }}>{cpLabel(c)}</span>;
}

function Tile({ c, on, busy, onToggle }: { c: ClusterCell; on: boolean; busy: boolean; onToggle: () => void }) {
    const img = c.cell.img;
    const src = img ? `${c.spriteBase}/${img.s}` : null;
    const machine = c.cell.c && c.cell.c !== c.cell.ref?.c ? c.cell.c : null;
    return (
        <li style={{ listStyle: 'none' }}>
            <button type="button" data-testid="cluster-tile" aria-pressed={on} disabled={busy} onClick={onToggle}
                title={`${c.chap} 册 · ${place(c.cell.a)}${on ? '（已挑出，再点放回）' : '（点一下挑出来单独处理）'}`}
                style={{ width: '100%', padding: 3, borderRadius: 6, cursor: busy ? 'default' : 'pointer', position: 'relative', textAlign: 'center',
                    border: on ? '2px solid #d33' : '1px solid #ddd', background: on ? '#fdecec' : '#fff', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
                {src && img
                    ? <span role="img" aria-label="字块裁图" style={{ width: img.w, height: img.h, zoom: 0.8, background: `#fff url(${src}) -${img.x}px -${img.y}px no-repeat` }} />
                    : <span style={{ width: 77, height: 77, fontSize: 11, color: '#999', display: 'flex', alignItems: 'center' }}>没有图</span>}
                <span style={{ fontSize: 11, lineHeight: 1.3, color: '#666' }}>{c.chap} 册 · {Number(c.cell.a.split(':')[0])} 叶</span>
                {machine && <span style={{ fontSize: 11, lineHeight: 1.2, color: '#a33' }}>机器读「<Zi c={machine} />」</span>}
                {on && <small style={{ position: 'absolute', top: 2, right: 2, fontSize: 10, lineHeight: 1.4, padding: '0 3px', borderRadius: 3, color: '#fff', background: '#d33' }}>挑出</small>}
            </button>
        </li>
    );
}

/** 挑出来的格：填别的字、字框切分有问题（可同时填字）、看不清 */
interface Special { char: string; cut: boolean; unsure: boolean }
const EMPTY: Special = { char: '', cut: false, unsure: false };

function SpecialRow({ c, v, onChange, onBack, busy, zi }: { zi: string; c: ClusterCell; v: Special; onChange: (v: Special) => void; onBack: () => void; busy: boolean }) {
    const img = c.cell.img;
    const src = img ? `${c.spriteBase}/${img.s}` : null;
    const id = `sp-${c.chap}-${c.cell.a}`.replace(/[^\w-]/g, '_');
    return (
        <li data-testid="special-row" style={{ listStyle: 'none', display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', padding: '8px 0', borderBottom: `1px solid ${tint}` }}>
            {src && img ? <span role="img" aria-label="字块裁图" style={{ width: img.w, height: img.h, background: `#fff url(${src}) -${img.x}px -${img.y}px no-repeat`, border: '1px solid #ddd', flex: 'none' }} /> : <span style={{ width: 96 }}>没有图</span>}
            <div style={{ minWidth: 0, flex: '1 1 14rem' }}>
                <div style={{ fontSize: 12, color: ink3 }}>{c.chap} 册 · {place(c.cell.a)}{c.cell.c && <> · 机器读「<Zi c={c.cell.c} />」</>}</div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
                    <label htmlFor={id} style={{ fontSize: 13, color: ink2 }}>实际是</label>
                    <input id={id} value={v.char} maxLength={2} disabled={busy || v.unsure} placeholder="填一个字" aria-label="实际是什么字"
                        onChange={e => { const ch = [...e.target.value].slice(-1).join(''); onChange({ ...v, char: ch, unsure: false }); }}
                        style={{ width: '5.5em', fontSize: 20, padding: '2px 8px', border: '1px solid #b8ad9a', borderRadius: 6 }} />
                    <label style={{ fontSize: 13, color: ink, display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                        <input type="checkbox" checked={v.cut} disabled={busy} onChange={e => onChange({ ...v, cut: e.target.checked })} />字框切分有问题
                    </label>
                    <label style={{ fontSize: 13, color: ink, display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                        <input type="checkbox" checked={v.unsure} disabled={busy} onChange={e => onChange({ ...v, unsure: e.target.checked, char: e.target.checked ? '' : v.char })} />看不清
                    </label>
                    <button type="button" style={{ ...BTN, fontSize: 12 }} disabled={busy} onClick={onBack}>放回去，按「<Zi c={zi} />」处理</button>
                </div>
            </div>
        </li>
    );
}

function Cluster({ book, clusterKey, cells: all, failed }: { book: string; clusterKey: string; cells: ClusterCell[]; failed: string[] }) {
    const pk = parseClusterKey(clusterKey)!;
    const spec = PENDING_REASONS[pk.reason];
    // 已处理的格（本机记录，同逐册页的 readDone）：打开时已处理过的不再摆出来
    const [done, setDone] = useState<Record<string, DoneMap>>({});
    useEffect(() => {
        const m: Record<string, DoneMap> = {};
        for (const c of all) if (!m[c.rev]) m[c.rev] = readDone(c.rev);
        setDone(m);
    }, [all]);
    const isDone = useCallback((c: ClusterCell) => !!done[c.rev]?.[c.cell.a], [done]);
    const open = useMemo(() => all.filter(c => !isDone(c)), [all, isDone]);
    const [skip, setSkip] = useState(0);          // 本页没处理的格往后排：每次摆 PAGE 格，处理完自然补上
    const page = open.slice(0, PAGE);
    const [picked, setPicked] = useState<Record<string, Special>>({});   // 挑出来单独处理的格
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState<string | null>(null);
    const [okCount, setOkCount] = useState(0);
    const canBulk = !!pk.char;
    const pickedHere = page.filter(c => picked[cid(c)]);
    const rest = page.filter(c => !picked[cid(c)]);
    const ready = pickedHere.filter(c => { const v = picked[cid(c)]; return v.char || v.cut || v.unsure; });
    const toggle = (c: ClusterCell) => setPicked(p => { const n = { ...p }; if (n[cid(c)]) delete n[cid(c)]; else n[cid(c)] = EMPTY; return n; });

    const submit = async () => {
        setBusy(true); setErr(null);
        const items: { c: ClusterCell; item: BatchItem; label: string }[] = [];
        if (canBulk) for (const c of rest) items.push({ c, label: `「${pk.char}」`, item: { book, vol: c.chap, a: c.cell.a, rev: c.rev, choice: 'char', char: pk.char, ...(c.cell.c ? { shown: c.cell.c } : {}), pick_src: 'cluster' } });
        for (const c of ready) {
            const v = picked[cid(c)];
            const base = { book, vol: c.chap, a: c.cell.a, rev: c.rev, ...(c.cell.c ? { shown: c.cell.c } : {}) };
            if (v.unsure) items.push({ c, label: '其他', item: { ...base, choice: 'unsure' } });
            else if (v.cut) items.push({ c, label: v.char ? `「${v.char}」＋字框切分错误` : '字框切分错误', item: { ...base, choice: 'cut', ...(v.char ? { char: v.char, pick_src: 'custom' as const } : {}) } });
            else items.push({ c, label: `「${v.char}」`, item: { ...base, choice: 'char', char: v.char, pick_src: 'custom' } });
        }
        const sentOk: { c: ClusterCell; label: string }[] = [];
        let firstErr: string | null = null;
        for (let i = 0; i < items.length; i += BATCH_MAX) {
            const chunk = items.slice(i, i + BATCH_MAX);
            const res = await submitBatch(chunk.map(x => x.item));
            res.forEach((r, j) => { if (r.ok) sentOk.push({ c: chunk[j].c, label: chunk[j].label }); else firstErr ??= r.error ?? '有格没交上'; });
            if (res.every(r => !r.ok)) break;
        }
        if (sentOk.length) {
            setDone(prev => {
                const next = { ...prev };
                for (const { c, label } of sentOk) { next[c.rev] = { ...(next[c.rev] ?? {}), [c.cell.a]: label }; }
                for (const rev of new Set(sentOk.map(x => x.c.rev))) writeDone(rev, next[rev]);
                return next;
            });
            setOkCount(n => n + sentOk.length);
            setPicked(p => { const n = { ...p }; for (const { c } of sentOk) delete n[cid(c)]; return n; });
        }
        setSkip(s => s + 0);
        setBusy(false);
        setErr(firstErr ? `已交上 ${sentOk.length} 格，其余没交上：${firstErr}` : null);
    };
    void skip;
    const total = all.length, finished = all.length - open.length;
    const nSubmit = (canBulk ? rest.length : 0) + ready.length;
    return (
        <div className="mx-auto max-w-[1100px] px-4 pb-16 pt-5">
            <section className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg p-4" style={{ backgroundColor: 'var(--color-raise)', border: `1px solid ${tint}` }}>
                <span style={{ fontSize: 56, lineHeight: 1, fontFamily: 'var(--font-serif)', color: ink }} data-testid="cluster-char">{pk.char ? <Zi c={pk.char} /> : '？'}</span>
                <div className="min-w-0 flex-1">
                    <h2 className="m-0 text-[19px] font-semibold" style={{ color: ink }}>{spec.label}{pk.char ? ` · 「${shownZi(pk.char)}」` : ''}</h2>
                    <p className="m-0 mt-1 text-[14px]" style={{ color: ink2 }}>{spec.hint}</p>
                    <p className="m-0 mt-1 text-[13px]" style={{ color: ink3 }}>
                        共 {total} 格，已处理 {finished} 格{okCount ? `（这次 ${okCount} 格）` : ''}，涉及 {new Set(all.map(c => c.chap)).size} 册。
                        {failed.length > 0 && <> 有 {failed.length} 册的名单没取到（{failed.join('、')}），刷新再试。</>}
                    </p>
                </div>
                <Link href={`/proofing/${book}`} className="text-[13px] underline" style={{ color: ink2 }}>回总览</Link>
            </section>

            {!canBulk && <p role="status" className="mt-4 text-[14px]" style={{ color: '#7a3b1d' }}>这一类没有整理本字，不能成批确认。请点开每一格，填上看到的字。</p>}
            {open.length === 0 ? (
                <p role="status" className="mt-8 text-[16px]" style={{ color: ink }}>这一类的字都处理完了，谢谢！<Link href={`/proofing/${book}`} className="ml-2 underline">回总览看看别的</Link></p>
            ) : (
                <section data-testid="cluster-review" className="mt-5 rounded-lg p-3" style={{ border: '1px solid #e2d6bf', background: '#fffdf7' }}>
                    <p className="m-0 text-[13px]" style={{ color: '#666' }}>
                        {canBulk ? <>每格下面是它所在的册和叶。图上都是「<b><Zi c={pk.char} /></b>」就直接确认。觉得不是、或字框切歪了的，点一下那格挑出来，在下面单独写。</> : <>点一格挑出来，在下面写它是什么字。</>}
                        {' '}本次 {page.length} 格，还有 {Math.max(0, open.length - page.length)} 格在后面。
                    </p>
                    <ul data-testid="cluster-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(88px, 1fr))', gap: 6, padding: 0, margin: '10px 0' }}>
                        {page.map(c => <Tile key={cid(c)} c={c} on={!!picked[cid(c)]} busy={busy} onToggle={() => toggle(c)} />)}
                    </ul>
                    {pickedHere.length > 0 && (
                        <div data-testid="special-panel" style={{ margin: '8px 0 12px' }}>
                            <div style={{ fontSize: 14, fontWeight: 600, color: '#a33' }}>单独处理的 {pickedHere.length} 格（什么都没填的先不交）</div>
                            <ul style={{ margin: 0, padding: 0 }}>
                                {pickedHere.map(c => <SpecialRow zi={pk.char} key={cid(c)} c={c} v={picked[cid(c)]} busy={busy} onBack={() => toggle(c)}
                                    onChange={v => setPicked(p => ({ ...p, [cid(c)]: v }))} />)}
                            </ul>
                        </div>
                    )}
                    <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                        <button type="button" data-testid="cluster-confirm" style={{ ...BTN_PRIMARY, opacity: busy || !nSubmit ? 0.45 : 1 }} disabled={busy || !nSubmit} onClick={submit}>
                            {canBulk && rest.length ? `确认这 ${rest.length} 格是「${shownZi(pk.char)}」` : '提交'}{ready.length ? `${canBulk && rest.length ? '，' : ''}另交 ${ready.length} 格单独处理` : ''}
                        </button>
                        {busy && <span style={{ fontSize: 12, color: '#666' }}>正在提交……</span>}
                        {err && <span role="alert" style={{ fontSize: 13, color: '#c33' }}>{err}</span>}
                    </div>
                </section>
            )}
            <p className="m-0 mt-6 text-[13px]" style={{ color: ink3 }}>不用登录，意见匿名收集，供整理时参考。成批确认的每一格，在整理里仍是一条独立的票。</p>
        </div>
    );
}

export default function ClusterClient({ book, clusterKey, info = null }: { book: string; clusterKey: string; info?: ProofBookInfo | null }) {
    const [state, setState] = useState<'loading' | 'none' | 'nocluster' | 'ok'>('loading');
    const [cells, setCells] = useState<ClusterCell[]>([]);
    const [failed, setFailed] = useState<string[]>([]);
    useEffect(() => {
        if (!parseClusterKey(clusterKey)) { setState('nocluster'); return; }
        let cancelled = false;
        (async () => {
            const s = await loadSummary(book);
            if (cancelled) return;
            if (!s) return setState('none');
            if (!s.clusters.some(c => c.k === clusterKey)) return setState('nocluster');
            const r = await loadClusterCells(book, clusterKey, s);
            if (cancelled) return;
            setCells(r.cells); setFailed(r.failed); setState(r.cells.length || r.failed.length ? 'ok' : 'nocluster');
        })().catch(() => { if (!cancelled) setState('none'); });
        return () => { cancelled = true; };
    }, [book, clusterKey]);
    const msg = (t: string) => <p role="status" className="mx-auto max-w-[1100px] px-4 py-8 text-[15px]" style={{ color: ink2 }}>{t}</p>;
    return (
        <LayoutWrapper hideFooter>
            <ProofHeader back={readerPath(book)} info={info} sub="成批校对" badge="校对中" />
            {state === 'loading' && msg('正在读取……')}
            {state === 'none' && msg('这本书的校对名单还没有发布，请稍后再来。')}
            {state === 'nocluster' && <div className="mx-auto max-w-[1100px] px-4 py-8 text-[15px]" style={{ color: ink2 }}>这一类现在没有待选的字了。<Link href={`/proofing/${book}`} className="ml-2 underline">回总览</Link></div>}
            {state === 'ok' && <Cluster book={book} clusterKey={clusterKey} cells={cells} failed={failed} />}
        </LayoutWrapper>
    );
}
