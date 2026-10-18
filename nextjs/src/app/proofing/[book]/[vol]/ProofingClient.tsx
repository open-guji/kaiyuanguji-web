'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createTextApi } from 'book-index-ui';
import { getTransport } from '@/lib/transport';
import { useSource } from '@/components/common/SourceContext';
import { getJson } from '@/lib/duidu-data';
import { loadFacsimile } from '@/lib/facsimile';
import {
    LACUNA, classLabel, contextAround, cropRect, ctxSrcLabel, getAid, libVerdictLabel, loadProofing, pageColOf, positionIndex, preselect, readDone,
    refOpLabel, resolveCrop, shownCandidates, spriteUrl, submitReview, whyLabel, writeDone,
    type Box, type CellContext, type CordIndex, type DoneMap, type PendingCell, type ReadSlot, type ReviewChoice, type ShownCand, type SpriteRef,
} from '@/lib/proofing';

/** 书影一页：阅读档、原图档地址与像素宽高 */
interface FacsPage { url: string; hires: string; width: number; height: number }

const PAGE_SIZE = 20;
const BOOK_RE = /^[A-Za-z0-9_-]{1,64}$/;

const OTHER_CHOICES: { choice: Exclude<ReviewChoice, 'char'>; label: string }[] = [
    { choice: 'none', label: '图上没有字' },
    { choice: 'unsure', label: '看不清' },
    { choice: 'cut', label: '切分错了' },
    { choice: 'jiazhu', label: '这是夹注小字' },
];

const imageCache = new Map<string, Promise<HTMLImageElement | null>>();
function loadImage(url: string): Promise<HTMLImageElement | null> {
    let p = imageCache.get(url);
    if (!p) {
        p = new Promise(resolve => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => resolve(null);
            img.src = url;
        });
        imageCache.set(url, p);
        p.then(img => { if (!img) imageCache.delete(url); }); // 失败不缓存，下次再试
    }
    return p;
}

/** 只负责把原叶图的一块画出来，不读回像素 */
function CellCrop({ src, crop }: { src: string; crop: { box: [number, number, number, number]; canvasWidth: number } }) {
    const [bx, by, bw, bh] = crop.box;
    const cw = crop.canvasWidth;
    const ref = useRef<HTMLCanvasElement>(null);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
        let cancelled = false;
        loadImage(src).then(img => {
            const cv = ref.current;
            if (cancelled || !cv) return;
            if (!img) return setFailed(true);
            const [sx, sy, sw, sh] = cropRect({ box: [bx, by, bw, bh], seq: '', canvasWidth: cw }, img.naturalWidth, img.naturalHeight);
            const scale = Math.min(2, 160 / Math.max(sw, sh));
            cv.width = Math.max(1, Math.round(sw * scale));
            cv.height = Math.max(1, Math.round(sh * scale));
            cv.getContext('2d')?.drawImage(img, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
        });
        return () => { cancelled = true; };
    }, [src, bx, by, bw, bh, cw]);
    if (failed) return <div style={{ color: '#999', fontSize: 12 }}>原图加载失败</div>;
    return <canvas ref={ref} aria-label="原叶裁图" style={{ maxWidth: 160, maxHeight: 160, background: '#eee' }} />;
}

/** 雪碧图里的一块（GUJI-557）。加载失败通知上层，由上层回退到原叶 IIIF 裁图 */
function SpriteCrop({ url, sprite, label, onFail }: { url: string; sprite: SpriteRef; label: string; onFail: (url: string) => void }) {
    useEffect(() => {
        let cancelled = false;
        loadImage(url).then(img => { if (!cancelled && !img) onFail(url); });
        return () => { cancelled = true; };
    }, [url, onFail]);
    return (
        <div role="img" aria-label={label} data-testid="sprite-crop"
            style={{ width: sprite.w, height: sprite.h, background: `#fff url(${url}) -${sprite.x}px -${sprite.y}px no-repeat`, border: '1px solid #ddd' }} />
    );
}

interface CellRowProps {
    cell: PendingCell;
    /** 能用的雪碧图地址（已排除加载失败的）；有就不用原叶裁图 */
    spriteSrc: string | null;
    spriteBase: (s: string) => string | null;
    onSpriteFail: (url: string) => void;
    imageUrl: string | null;
    crop: { box: [number, number, number, number]; canvasWidth: number } | null;
    done?: string;
    onSubmit: (cell: PendingCell, choice: ReviewChoice, char?: string) => Promise<string | null>;
    context: CellContext | null;
    pendingSet: Set<string>;
    selected: boolean;
    onSelect: (a: string) => void;
}

function CandButton({ cd, busy, picked, onPick }: { cd: ShownCand; busy: boolean; picked: boolean; onPick: (c: string) => void }) {
    const tip = [cd.src?.length ? `来源：${cd.src.join('、')}` : '', cd.score !== undefined ? `库分数 ${cd.score.toFixed(4)}` : ''].filter(Boolean).join('；');
    return (
        <button type="button" disabled={busy} aria-pressed={picked} onClick={() => onPick(cd.c)} title={tip || undefined}
            style={{ fontSize: 22, padding: '2px 10px', ...(picked ? { outline: '2px solid #2a7' } : {}) }}>
            {cd.c}{cd.score !== undefined && <small style={{ fontSize: 11, color: '#888', marginLeft: 4 }}>{cd.score.toFixed(2)}</small>}
        </button>
    );
}

const f4 = (n: number) => n.toFixed(4);

/** 第五步（字形库比对）、第六步（上下文判定）和整理本对位：先给一行摘要，细数放在可展开的「机器判读细节」里 */
function Evidence({ cell }: { cell: PendingCell }) {
    const top = cell.libTop?.[0];
    const summary: React.ReactNode[] = [];
    if (cell.lib?.verdict || top) {
        summary.push(<div key="lib"><b>字形库</b>：{cell.lib?.verdict ? libVerdictLabel(cell.lib.verdict) : '—'}{top ? `，最像「${top.c}」（相似度 ${top.s.toFixed(2)}）` : ''}</div>);
    }
    if (cell.ctx) {
        summary.push(<div key="ctx"><b>上下文</b>：{cell.ctx.c ? `读作「${cell.ctx.c}」${cell.ctx.src ? `（${ctxSrcLabel(cell.ctx.src)}）` : ''}` : '没定出字'}</div>);
    }
    if (cell.ocr?.length) summary.push(<div key="ocr"><b>OCR</b>：{cell.ocr.map(o => `「${o.c}」`).join('')}</div>);
    const rows: [string, React.ReactNode][] = [];
    if (cell.cls) {
        const k = classLabel(cell.cls, cell.clsSub);
        rows.push(['类别', <>{k.name}{k.hint ? <span style={{ color: '#888' }}>　{k.hint}</span> : null}</>]);
    }
    if (cell.why?.length) rows.push(['待审原因码', cell.why.map(w => `${w}（${whyLabel(w)}）`).join('、')]);
    if (cell.libTop?.length) rows.push(['第五步 字形库前几名', cell.libTop.map(x => `${x.c} ${f4(x.s)}`).join('　')]);
    if (cell.lib) {
        const parts = [
            cell.lib.verdict ? `判定 ${cell.lib.verdict}（${libVerdictLabel(cell.lib.verdict)}）` : '',
            cell.lib.cov !== undefined ? `相似度 cov ${f4(cell.lib.cov)}` : '',
            cell.lib.wmax !== undefined ? `最大墨差 wmax ${cell.lib.wmax}` : '',
        ].filter(Boolean);
        if (parts.length) rows.push(['第五步 字形库判定', parts.join('，')]);
    }
    if (cell.ctx) {
        rows.push(['第六步 上下文判定', [
            cell.ctx.c ? `读作「${cell.ctx.c}」` : '没定出字',
            cell.ctx.margin !== undefined ? `领先幅度 margin ${f4(cell.ctx.margin)}` : '',
            cell.ctx.src ? `来源 ${cell.ctx.src}（${ctxSrcLabel(cell.ctx.src)}）` : '',
        ].filter(Boolean).join('，')]);
    }
    if (cell.ref) rows.push(['整理本对位', `「${cell.ref.c}」${cell.ref.op ? `，${cell.ref.op}（${refOpLabel(cell.ref.op)}）` : ''}`]);
    if (cell.ocr?.length) rows.push(['OCR', cell.ocr.map(o => `${o.c}${o.src ? `（${o.src}）` : ''}`).join('　')]);
    if (cell.stale) rows.push(['旧裁决', `「${cell.stale.c}」${cell.stale.ts ? `，${cell.stale.ts.slice(0, 10)}` : ''}${cell.stale.state ? `，${cell.stale.state === 'withdrawn' ? '已撤下' : '已失效'}` : ''}`]);
    if (cell.occ) rows.push(['遮挡', cell.occ.refBlank ? '印章或污损遮挡，整理本此位为空' : `印章或污损遮挡${cell.occ.c ? `，整理本作「${cell.occ.c}」` : ''}`]);
    if (!summary.length && !rows.length) return null;
    return (
        <div data-testid="evidence" style={{ marginTop: 8, fontSize: 13, color: '#555' }}>
            {summary}
            {rows.length > 0 && (
                <details style={{ marginTop: 4 }}>
                    <summary style={{ cursor: 'pointer' }}>机器判读细节</summary>
                    <table style={{ borderCollapse: 'collapse', marginTop: 4 }}>
                        <tbody>
                            {rows.map(([k, v]) => (
                                <tr key={k}>
                                    <th style={{ textAlign: 'left', fontWeight: 'normal', color: '#888', padding: '2px 12px 2px 0', whiteSpace: 'nowrap', verticalAlign: 'top' }}>{k}</th>
                                    <td style={{ padding: '2px 0' }}>{v}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </details>
            )}
        </div>
    );
}

/** 本位前后各十个字（跨列、跨页）。本位标红框；也在待审的字标橙色；换列处留一道细线 */
function ContextLine({ ctx, at, atChar, pendingSet }: { ctx: CellContext; at: string; atChar?: string; pendingSet: Set<string> }) {
    const colKey = (a: string) => pageColOf(a)?.join(':') ?? '';
    const pieces: React.ReactNode[] = [];
    let prev: string | null = null;
    const push = (slot: ReadSlot, isAt: boolean) => {
        const key = colKey(slot.a);
        if (prev !== null && key !== prev) pieces.push(<span key={`sep-${slot.a}`} aria-hidden style={{ display: 'inline-block', width: 1, height: '1em', background: '#ccc', margin: '0 4px', verticalAlign: 'middle' }} />);
        prev = key;
        if (isAt) {
            pieces.push(<mark key={slot.a} data-testid="ctx-at" style={{ background: 'none', border: '2px solid #d33', padding: '0 2px', color: 'inherit' }}>{slot.c && slot.c !== LACUNA ? slot.c : '？'}</mark>);
        } else if (pendingSet.has(slot.a)) {
            pieces.push(<span key={slot.a} title={`格 ${slot.a} 也在待审`} style={{ color: '#c70' }}>{slot.c && slot.c !== LACUNA ? slot.c : '？'}</span>);
        } else {
            pieces.push(<span key={slot.a} title={`格 ${slot.a}`}>{slot.c || '□'}</span>);
        }
    };
    ctx.before.forEach(s => push(s, false));
    push({ a: at, c: atChar ?? '' }, true);
    ctx.after.forEach(s => push(s, false));
    return (
        <div data-testid="context" style={{ marginTop: 8, fontSize: 20, letterSpacing: 2, lineHeight: 1.6 }}>
            <span style={{ fontSize: 12, color: '#888', letterSpacing: 0, marginRight: 8 }}>上下文</span>
            {pieces}
        </div>
    );
}

function Examples({ cell, spriteBase }: { cell: PendingCell; spriteBase: (s: string) => string | null }) {
    const [bad, setBad] = useState<Set<string>>(new Set());
    const entries = Object.entries(cell.ex ?? {});
    const urlKey = [...new Set(entries.flatMap(([, list]) => list.map(sp => spriteBase(sp.s)).filter((u): u is string => !!u)))].join('\n');
    useEffect(() => {
        let cancelled = false;
        // 例子图没传到桶（或加载失败）就不显示，不留空白框
        (urlKey ? urlKey.split('\n') : []).forEach(u => loadImage(u).then(img => { if (!cancelled && !img) setBad(prev => (prev.has(u) ? prev : new Set(prev).add(u))); }));
        return () => { cancelled = true; };
    }, [urlKey]);
    const shown = entries
        .map(([ch, list]) => [ch, list.filter(sp => { const u = spriteBase(sp.s); return !!u && !bad.has(u); })] as const)
        .filter(([, list]) => list.length > 0);
    if (!shown.length) return null;
    return (
        <div data-testid="examples" style={{ marginTop: 8, fontSize: 13, color: '#555' }}>
            同字例子
            {shown.map(([ch, list]) => (
                <div key={ch} style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                    <b style={{ fontSize: 18 }}>{ch}</b>
                    {list.map((sp, i) => (
                        <div key={i} role="img" aria-label={`「${ch}」例 ${i + 1}`}
                            style={{ width: sp.w, height: sp.h, zoom: 0.5, border: '1px solid #ddd', background: `#fff url(${spriteBase(sp.s)}) -${sp.x}px -${sp.y}px no-repeat` }} />
                    ))}
                </div>
            ))}
        </div>
    );
}

function CellRow({ cell, spriteSrc, spriteBase, onSpriteFail, imageUrl, crop, done, onSubmit, context, pendingSet, selected, onSelect }: CellRowProps) {
    const [custom, setCustom] = useState('');
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState<string | null>(null);
    const [showMore, setShowMore] = useState(false);
    const pre = useMemo(() => preselect(cell), [cell]);
    const go = async (choice: ReviewChoice, char?: string) => {
        setBusy(true);
        setErr(null);
        const e = await onSubmit(cell, choice, char);
        setBusy(false);
        if (e) setErr(e);
    };
    const { top, more } = shownCandidates(cell);
    const preCand = pre?.choice === 'char' ? pre.char : undefined;
    const why = cell.why?.filter(w => w !== 'none').map(whyLabel) ?? [];
    const preNone = pre?.choice === 'none';
    return (
        <li id={`cell-${cell.a}`} data-testid="cell-card" data-selected={selected ? '1' : undefined}
            onClickCapture={() => onSelect(cell.a)} onFocusCapture={() => onSelect(cell.a)}
            style={{ border: selected ? '2px solid #d33' : '1px solid #ddd', borderRadius: 6, padding: selected ? 11 : 12, marginBottom: 12, listStyle: 'none', opacity: done && !selected ? 0.6 : 1, scrollMarginTop: 96 }}>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                {spriteSrc && cell.img ? <SpriteCrop url={spriteSrc} sprite={cell.img} label="字块裁图" onFail={onSpriteFail} />
                    : imageUrl && crop ? <CellCrop src={imageUrl} crop={crop} /> : <div style={{ color: '#999', fontSize: 12 }}>（无裁图，仅供看字）</div>}
                <div>
                    <div style={{ fontSize: 12, color: '#666' }}>{cellPlace(cell.a)}　{cell.c ? '机器读作' : '机器没定出字'}</div>
                    <div style={{ fontSize: 40, lineHeight: 1.2 }}>{cell.c || '？'}</div>
                    {cell.ref && <div style={{ fontSize: 13, color: '#666' }}>整理本作「{cell.ref.c}」</div>}
                </div>
            </div>
            {context && <ContextLine ctx={context} at={cell.a} atChar={cell.c} pendingSet={pendingSet} />}
            {(why.length > 0 || cell.cls) && (
                <div data-testid="why" style={{ marginTop: 6, fontSize: 13, color: '#a60' }}>
                    待审原因：{why.length ? why.join('、') : cell.why?.includes('none') ? whyLabel('none') : cell.cls}
                </div>
            )}
            <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                {top.map(cd => <CandButton key={cd.c} cd={cd} busy={busy} picked={cd.c === preCand} onPick={c => go('char', c)} />)}
                {showMore && more.map(cd => <CandButton key={cd.c} cd={cd} busy={busy} picked={cd.c === preCand} onPick={c => go('char', c)} />)}
                {more.length > 0 && (
                    <button type="button" onClick={() => setShowMore(v => !v)} aria-expanded={showMore}>{showMore ? '收起' : `更多（${more.length}）`}</button>
                )}
                {cell.c && !top.some(cd => cd.c === cell.c) && !more.some(cd => cd.c === cell.c) && (
                    <button type="button" disabled={busy} onClick={() => go('char', cell.c)} style={{ fontSize: 22, padding: '2px 10px' }}>{cell.c}</button>
                )}
                <input value={custom} onChange={e => setCustom(e.target.value)} placeholder="另写一字" aria-label="另写一字" style={{ width: 72 }} />
                <button type="button" disabled={busy || [...custom].length !== 1} onClick={() => go('char', custom)}>提交此字</button>
            </div>
            {preCand && !done && (
                <div data-testid="preselect" style={{ marginTop: 6, fontSize: 13 }}>
                    预选「{preCand}」（上次的裁决已失效，请对图确认）
                    <button type="button" disabled={busy} onClick={() => go('char', preCand)} style={{ marginLeft: 8 }}>确认「{preCand}」</button>
                </div>
            )}
            <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {OTHER_CHOICES.map(o => (
                    <button key={o.choice} type="button" disabled={busy} aria-pressed={preNone && o.choice === 'none'} onClick={() => go(o.choice)}
                        style={preNone && o.choice === 'none' ? { outline: '2px solid #2a7' } : undefined}>{o.label}</button>
                ))}
            </div>
            {preNone && !done && <div data-testid="preselect" style={{ marginTop: 6, fontSize: 13 }}>预选「图上没有字」（印章或污损遮挡），点一下按钮确认。</div>}
            <Evidence cell={cell} />
            <Examples cell={cell} spriteBase={spriteBase} />
            {done && <div style={{ marginTop: 6, color: '#2a7' }}>已提交：{done}（可再点改）</div>}
            {err && <div role="alert" style={{ marginTop: 6, color: '#c33' }}>{err}</div>}
        </li>
    );
}

/** 「第 9 葉 第 7 列第 17 字」；夹注半格带「（夹注右/左）」 */
function cellPlace(a: string): string {
    const m = /^(\d+):(\d+):(\d+)([a-z]?)$/.exec(a);
    if (!m) return `格 ${a}`;
    const half = m[4] === 'a' ? '（夹注右行）' : m[4] === 'b' ? '（夹注左行）' : '';
    return `第 ${Number(m[1])} 葉 第 ${Number(m[2])} 列第 ${Number(m[3])} 字${half}`;
}

const ZOOMS = [1, 2, 4] as const;

/** 左栏：选中格所在的整页影印，红框框出正在审的字；同页其他待审格虚线框，点一下切过去 */
function PagePanel({ page, pageNo, canvasW, canvasH, boxes, selected, onSelect, fitHeight }: {
    page: FacsPage | null;
    pageNo: number | null;
    canvasW: number;
    canvasH: number;
    boxes: { a: string; box: Box }[];
    selected: string | null;
    onSelect: (a: string) => void;
    fitHeight: string;
}) {
    const [zoom, setZoom] = useState<(typeof ZOOMS)[number]>(1);
    const [loaded, setLoaded] = useState<string | null>(null);
    const [failed, setFailed] = useState<string | null>(null);
    const scroller = useRef<HTMLDivElement>(null);
    const W = canvasW || page?.width || 0;
    const H = canvasH || page?.height || 0;
    const src = page ? (zoom === 1 ? page.url : page.hires) : null;
    const sel = boxes.find(b => b.a === selected) ?? null;
    // 放大时把选中的字滚到视口中间
    useEffect(() => {
        const el = scroller.current;
        if (!el || !sel || !W || !H) return;
        const [x, y, w, h] = sel.box;
        const cw = el.scrollWidth;
        const ch = el.scrollHeight;
        el.scrollLeft = Math.max(0, ((x + w / 2) / W) * cw - el.clientWidth / 2);
        el.scrollTop = Math.max(0, ((y + h / 2) / H) * ch - el.clientHeight / 2);
    }, [sel, zoom, W, H, loaded]);
    if (pageNo === null) return <div style={{ color: '#999', fontSize: 13, padding: 12 }}>这一格没有整页坐标，只能看卡片上的裁图。</div>;
    const pad = 0.12;
    const pct = (b: Box) => {
        const [x, y, w, h] = b;
        return { left: `${((x - w * pad) / W) * 100}%`, top: `${((y - h * pad) / H) * 100}%`, width: `${((w * (1 + 2 * pad)) / W) * 100}%`, height: `${((h * (1 + 2 * pad)) / H) * 100}%` };
    };
    return (
        <div data-testid="page-panel">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#555', marginBottom: 6, flexWrap: 'wrap' }}>
                <b>第 {pageNo} 葉</b>
                {sel && <span>红框：{cellPlace(sel.a)}</span>}
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                    {ZOOMS.map(z => (
                        <button key={z} type="button" aria-pressed={zoom === z} onClick={() => setZoom(z)}
                            style={{ padding: '0 8px', border: '1px solid #ccc', borderRadius: 4, background: zoom === z ? '#eee' : '#fff' }}>
                            {z === 1 ? '整页' : `${z}×`}
                        </button>
                    ))}
                </span>
            </div>
            <div ref={scroller} style={{ overflow: 'auto', height: fitHeight, background: '#f4f1ea', border: '1px solid #ddd', borderRadius: 4 }}>
                {!page || !W || !H ? (
                    <div style={{ color: '#999', fontSize: 13, padding: 12 }}>{page ? '这一页缺尺寸，画不了框。' : '书影加载中…'}</div>
                ) : (
                    <div style={{ position: 'relative', margin: '0 auto', width: zoom === 1 ? `min(100%, calc(${fitHeight} * ${W / H}))` : `${zoom * 100}%` }}>
                        {src && failed !== src
                            ? <img src={src} alt={`第 ${pageNo} 葉书影`} onLoad={() => setLoaded(src)} onError={() => setFailed(src)} style={{ display: 'block', width: '100%', height: 'auto' }} />
                            : <div style={{ paddingTop: `${(H / W) * 100}%`, color: '#999', fontSize: 13 }}>书影加载失败</div>}
                        {boxes.map(b => {
                            const on = b.a === selected;
                            return (
                                <button key={b.a} type="button" data-testid="page-box" data-selected={on ? '1' : undefined}
                                    aria-label={`${cellPlace(b.a)}${on ? '（正在审）' : ''}`} title={cellPlace(b.a)} onClick={() => onSelect(b.a)}
                                    style={{ position: 'absolute', ...pct(b.box), padding: 0, background: 'transparent', cursor: 'pointer',
                                        border: on ? '3px solid #e00' : '2px dashed rgba(230,140,0,0.8)', boxShadow: on ? '0 0 0 2px rgba(255,255,255,0.8)' : undefined, zIndex: on ? 2 : 1 }} />
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}

const doneLabel = (choice: ReviewChoice, char?: string) =>
    choice === 'char' ? `「${char}」` : OTHER_CHOICES.find(o => o.choice === choice)?.label ?? choice;

export default function ProofingClient({ book, vol }: { book: string; vol: string }) {
    const { source } = useSource();
    const transport = useMemo(() => getTransport(source), [source]);
    const [state, setState] = useState<'loading' | 'none' | 'error' | 'ok'>('loading');
    const [rev, setRev] = useState<string | null>(null);
    const [cells, setCells] = useState<PendingCell[]>([]);
    const [cord, setCord] = useState<CordIndex | null>(null);
    const [order, setOrder] = useState<ReadSlot[]>([]);
    const [images, setImages] = useState<Map<string, FacsPage>>(new Map());
    const [pendingFile, setPendingFile] = useState<string | null>(null);
    const [spriteFail, setSpriteFail] = useState<Set<string>>(new Set());
    const [done, setDone] = useState<DoneMap>({});
    const [page, setPage] = useState(0);
    const [sel, setSel] = useState<string | null>(null);
    const [panelOpen, setPanelOpen] = useState(true);

    useEffect(() => {
        if (!BOOK_RE.test(book) || !BOOK_RE.test(vol)) return setState('none');
        let cancelled = false;
        const api = createTextApi(transport);
        (async () => {
            const res = await loadProofing(
                { getManifest: id => api.getManifest(id), getIndex: (id, key) => api.getIndex(id, key), getFile: (id, key, file) => getJson(transport, id, key, file) },
                book, vol,
            );
            if (cancelled) return;
            if (res.status !== 'ok') return setState(res.status);
            setRev(res.pending.rev);
            setCells(res.pending.cells);
            setCord(res.cord);
            setOrder(res.order ?? []);
            setPendingFile(res.pendingFile);
            setDone(res.pending.rev ? readDone(res.pending.rev) : {});
            setState('ok');
        })().catch(() => { if (!cancelled) setState('error'); });
        return () => { cancelled = true; };
    }, [book, vol, transport]);

    // 书影（IIIF manifest）：左栏整页要用，雪碧图缺的格也靠它裁图。失败不影响看字和提交
    const iiifVol = cord?.iiifVol ?? vol;
    useEffect(() => {
        if (state !== 'ok') return;
        let cancelled = false;
        loadFacsimile(book, iiifVol).then(facs => {
            if (cancelled || !facs) return;
            setImages(new Map(facs.flatMap(f => (f.seq ? [[f.seq, { url: f.url, hires: f.hiresUrl ?? f.url, width: f.width ?? 0, height: f.height ?? 0 }] as [string, FacsPage]] : []))));
        }).catch(() => { /* 没有书影就只看字 */ });
        return () => { cancelled = true; };
    }, [state, book, iiifVol]);

    const onSpriteFail = useCallback((url: string) => setSpriteFail(prev => (prev.has(url) ? prev : new Set(prev).add(url))), []);
    const spriteOf = useCallback((cell: PendingCell): string | null => {
        const url = cell.img ? spriteUrl(book, pendingFile, cell.img.s) : null;
        return url && !spriteFail.has(url) ? url : null;
    }, [book, pendingFile, spriteFail]);
    const spriteBase = useCallback((f: string) => spriteUrl(book, pendingFile, f), [book, pendingFile]);

    const pos = useMemo(() => positionIndex(order), [order]);
    const pendingSet = useMemo(() => new Set(cells.map(c => c.a)), [cells]);

    const onSubmit = useCallback(async (cell: PendingCell, choice: ReviewChoice, char?: string) => {
        if (!rev) return '这份待审单缺少版本号，暂时不能提交';
        const e = await submitReview({ book, vol, a: cell.a, rev, choice, ...(char ? { char } : {}), ...(cell.c ? { shown: cell.c } : {}) }, getAid());
        if (e) return e;
        setDone(prev => {
            const next = { ...prev, [cell.a]: doneLabel(choice, char) };
            writeDone(rev, next);
            return next;
        });
        return null;
    }, [book, vol, rev]);

    const pages = Math.max(1, Math.ceil(cells.length / PAGE_SIZE));
    const cur = Math.min(page, pages - 1);
    const slice = useMemo(() => cells.slice(cur * PAGE_SIZE, (cur + 1) * PAGE_SIZE), [cells, cur]);
    const selected = sel && slice.some(c => c.a === sel) ? sel : slice[0]?.a ?? null;
    const selCell = selected ? cells.find(c => c.a === selected) ?? null : null;
    const selCrop = selCell ? resolveCrop(selCell, cord) : null;
    const selPageNo = selCell ? pageColOf(selCell.a)?.[0] ?? null : null;
    const pageBoxes = useMemo(() => {
        if (selPageNo === null) return [];
        return cells.flatMap(c => {
            if (pageColOf(c.a)?.[0] !== selPageNo) return [];
            const cr = resolveCrop(c, cord);
            return cr ? [{ a: c.a, box: cr.box }] : [];
        });
    }, [cells, cord, selPageNo]);

    // 在整页上点了别的待审格：翻到它所在的那一页卡片并滚过去
    const selectFromPage = useCallback((a: string) => {
        const idx = cells.findIndex(c => c.a === a);
        if (idx < 0) return;
        setPage(Math.floor(idx / PAGE_SIZE));
        setSel(a);
        setTimeout(() => document.getElementById(`cell-${a}`)?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }), 0);
    }, [cells]);

    if (state === 'loading') return <main style={{ padding: 24 }}>加载中…</main>;
    if (state === 'none') return <main style={{ padding: 24 }}>这一册暂时没有待校对的字。</main>;
    if (state === 'error') return <main style={{ padding: 24 }}>待校对数据暂时取不到，请稍后再试。</main>;

    const doneCount = cells.filter(c => done[c.a]).length;
    const panelPage = selCrop ? images.get(selCrop.seq) ?? null : null;
    return (
        <main className="mx-auto max-w-[1400px] px-4 py-6">
            <h1 style={{ fontSize: 22 }}>精校：{book} / {vol}</h1>
            <p style={{ color: '#666' }}>请对照原图，告诉我们每格是什么字。左边是这一格所在的整页，红框是正在审的字；卡片上有前后文和机器的判读依据。共 {cells.length} 格待审，你已回应 {doneCount} 格。意见匿名收集，仅供校勘参考。</p>
            {cells.length === 0 && <p>这一册的待审格已清空，谢谢！</p>}
            {cells.length > 0 && (
                <div className="lg:flex lg:items-start lg:gap-6">
                    <aside className="sticky top-0 z-10 mb-4 bg-[var(--color-paper)] py-2 [--proof-page-h:38vh] lg:top-20 lg:[--proof-page-h:calc(100vh-9rem)] lg:mb-0 lg:w-[46%] lg:shrink-0 lg:py-0">
                        <button type="button" className="lg:hidden" onClick={() => setPanelOpen(v => !v)} aria-expanded={panelOpen} style={{ fontSize: 13, marginBottom: 4 }}>
                            {panelOpen ? '收起整页' : '显示整页'}
                        </button>
                        <div className={panelOpen ? '' : 'hidden lg:block'}>
                            <PagePanel page={panelPage} pageNo={selCrop ? selPageNo : null} canvasW={selCrop?.canvasWidth ?? 0} canvasH={selCrop?.canvasHeight ?? 0}
                                boxes={pageBoxes} selected={selected} onSelect={selectFromPage} fitHeight="var(--proof-page-h)" />
                        </div>
                    </aside>
                    <div className="min-w-0 lg:flex-1">
                        <ul style={{ padding: 0 }}>
                            {slice.map(cell => {
                                const crop = resolveCrop(cell, cord);
                                return <CellRow key={cell.a} cell={cell} crop={crop} imageUrl={crop ? images.get(crop.seq)?.hires ?? null : null} spriteSrc={spriteOf(cell)} spriteBase={spriteBase} onSpriteFail={onSpriteFail} done={done[cell.a]} onSubmit={onSubmit}
                                    context={contextAround(order, pos, cell.a)} pendingSet={pendingSet} selected={cell.a === selected} onSelect={setSel} />;
                            })}
                        </ul>
                        {pages > 1 && (
                            <nav style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                                <button type="button" disabled={cur === 0} onClick={() => setPage(cur - 1)}>上一页</button>
                                <span>{cur + 1} / {pages}</span>
                                <button type="button" disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)}>下一页</button>
                            </nav>
                        )}
                    </div>
                </div>
            )}
        </main>
    );
}
