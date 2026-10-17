'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createTextApi } from 'book-index-ui';
import { getTransport } from '@/lib/transport';
import { useSource } from '@/components/common/SourceContext';
import { getJson } from '@/lib/duidu-data';
import { loadFacsimile } from '@/lib/facsimile';
import {
    cropRect, getAid, loadProofing, preselect, readDone, resolveCrop, shownCandidates, spriteUrl, submitReview, whyLabel, writeDone,
    type CordIndex, type DoneMap, type PendingCell, type ReviewChoice, type ShownCand, type SpriteRef,
} from '@/lib/proofing';

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
}

const cls = (...xs: (string | false | undefined)[]) => xs.filter(Boolean).join(' ');

function CandButton({ cd, busy, picked, onPick }: { cd: ShownCand; busy: boolean; picked: boolean; onPick: (c: string) => void }) {
    const tip = [cd.src?.length ? `来源：${cd.src.join('、')}` : '', cd.score !== undefined ? `库分数 ${cd.score.toFixed(4)}` : ''].filter(Boolean).join('；');
    return (
        <button type="button" disabled={busy} aria-pressed={picked} onClick={() => onPick(cd.c)} title={tip || undefined}
            style={{ fontSize: 22, padding: '2px 10px', ...(picked ? { outline: '2px solid #2a7' } : {}) }}>
            {cd.c}{cd.score !== undefined && <small style={{ fontSize: 11, color: '#888', marginLeft: 4 }}>{cd.score.toFixed(2)}</small>}
        </button>
    );
}

function Evidence({ cell }: { cell: PendingCell }) {
    const rows: React.ReactNode[] = [];
    if (cell.libTop?.length) rows.push(<div key="lib">字形库前几名：{cell.libTop.map(x => `${x.c} ${x.s.toFixed(4)}`).join('　')}{cell.lib?.verdict ? `（判定 ${cell.lib.verdict}）` : ''}</div>);
    if (cell.ctx) rows.push(<div key="ctx">上下文模型读作「{cell.ctx.c}」{cell.ctx.margin !== undefined ? `，领先 ${cell.ctx.margin.toFixed(2)}` : ''}{cell.ctx.src ? `（${cell.ctx.src}）` : ''}</div>);
    if (cell.ocr?.length) rows.push(<div key="ocr">OCR：{cell.ocr.map(o => `${o.c}${o.src ? `（${o.src}）` : ''}`).join('　')}</div>);
    if (!rows.length) return null;
    return (
        <details style={{ marginTop: 8, fontSize: 13, color: '#555' }}>
            <summary>依据</summary>
            {rows}
        </details>
    );
}

function Examples({ cell, spriteBase }: { cell: PendingCell; spriteBase: (s: string) => string | null }) {
    const entries = Object.entries(cell.ex ?? {});
    if (!entries.length) return null;
    return (
        <div style={{ marginTop: 8, fontSize: 13, color: '#555' }}>
            同字例子
            {entries.map(([ch, list]) => (
                <div key={ch} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                    <b style={{ fontSize: 18 }}>{ch}</b>
                    {list.map((sp, i) => {
                        const url = spriteBase(sp.s);
                        return url ? <div key={i} role="img" aria-label={`「${ch}」例 ${i + 1}`} style={{ width: sp.w, height: sp.h, zoom: 0.5, background: `#fff url(${url}) -${sp.x}px -${sp.y}px no-repeat` }} /> : null;
                    })}
                </div>
            ))}
        </div>
    );
}

function CellRow({ cell, spriteSrc, spriteBase, onSpriteFail, imageUrl, crop, done, onSubmit }: CellRowProps) {
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
        <li style={{ border: '1px solid #ddd', borderRadius: 6, padding: 12, marginBottom: 12, listStyle: 'none', opacity: done ? 0.6 : 1 }}>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                {spriteSrc && cell.img ? <SpriteCrop url={spriteSrc} sprite={cell.img} label="字块裁图" onFail={onSpriteFail} />
                    : imageUrl && crop ? <CellCrop src={imageUrl} crop={crop} /> : <div style={{ color: '#999', fontSize: 12 }}>（无裁图，仅供看字）</div>}
                <div>
                    <div style={{ fontSize: 12, color: '#666' }}>格 {cell.a}　机器读作</div>
                    <div style={{ fontSize: 40, lineHeight: 1.2 }}>{cell.c || '？'}</div>
                    {cell.ref && <div style={{ fontSize: 13, color: '#666' }}>整理本作「{cell.ref.c}」</div>}
                </div>
            </div>
            {(why.length > 0 || cell.cls) && (
                <div data-testid="why" style={{ marginTop: 6, fontSize: 13, color: '#a60' }}>
                    待审原因：{why.length ? why.join('、') : cell.cls}
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

const doneLabel = (choice: ReviewChoice, char?: string) =>
    choice === 'char' ? `「${char}」` : OTHER_CHOICES.find(o => o.choice === choice)?.label ?? choice;

export default function ProofingClient({ book, vol }: { book: string; vol: string }) {
    const { source } = useSource();
    const transport = useMemo(() => getTransport(source), [source]);
    const [state, setState] = useState<'loading' | 'none' | 'error' | 'ok'>('loading');
    const [rev, setRev] = useState<string | null>(null);
    const [cells, setCells] = useState<PendingCell[]>([]);
    const [cord, setCord] = useState<CordIndex | null>(null);
    const [images, setImages] = useState<Map<string, string>>(new Map());
    const [pendingFile, setPendingFile] = useState<string | null>(null);
    const [spriteFail, setSpriteFail] = useState<Set<string>>(new Set());
    const [facsWanted, setFacsWanted] = useState(false);
    const [done, setDone] = useState<DoneMap>({});
    const [page, setPage] = useState(0);

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
            setPendingFile(res.pendingFile);
            setDone(res.pending.rev ? readDone(res.pending.rev) : {});
            setState('ok');
        })().catch(() => { if (!cancelled) setState('error'); });
        return () => { cancelled = true; };
    }, [book, vol, transport]);

    // 书影（IIIF manifest + 原叶图）只在这一页有格子用得上原叶裁图时才取：全有雪碧图就一张都不取。失败不影响看字和提交
    const iiifVol = cord?.iiifVol ?? vol;
    useEffect(() => {
        if (!facsWanted || state !== 'ok') return;
        let cancelled = false;
        loadFacsimile(book, iiifVol).then(facs => {
            if (cancelled || !facs) return;
            setImages(new Map(facs.flatMap(f => (f.seq ? [[f.seq, f.hiresUrl ?? f.url] as [string, string]] : []))));
        }).catch(() => { /* 没有书影就只看字 */ });
        return () => { cancelled = true; };
    }, [facsWanted, state, book, iiifVol]);

    const onSpriteFail = useCallback((url: string) => setSpriteFail(prev => (prev.has(url) ? prev : new Set(prev).add(url))), []);
    const spriteOf = useCallback((cell: PendingCell): string | null => {
        const url = cell.img ? spriteUrl(book, pendingFile, cell.img.s) : null;
        return url && !spriteFail.has(url) ? url : null;
    }, [book, pendingFile, spriteFail]);
    const spriteBase = useCallback((f: string) => spriteUrl(book, pendingFile, f), [book, pendingFile]);

    const needFacs = useMemo(() => {
        const cur = Math.min(page, Math.max(1, Math.ceil(cells.length / PAGE_SIZE)) - 1);
        return cells.slice(cur * PAGE_SIZE, (cur + 1) * PAGE_SIZE).some(c => !spriteOf(c));
    }, [cells, page, spriteOf]);
    useEffect(() => { if (state === 'ok' && needFacs) setFacsWanted(true); }, [state, needFacs]);

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

    if (state === 'loading') return <main style={{ padding: 24 }}>加载中…</main>;
    if (state === 'none') return <main style={{ padding: 24 }}>这一册暂时没有待校对的字。</main>;
    if (state === 'error') return <main style={{ padding: 24 }}>待校对数据暂时取不到，请稍后再试。</main>;

    const pages = Math.max(1, Math.ceil(cells.length / PAGE_SIZE));
    const cur = Math.min(page, pages - 1);
    const slice = cells.slice(cur * PAGE_SIZE, (cur + 1) * PAGE_SIZE);
    const doneCount = cells.filter(c => done[c.a]).length;
    return (
        <main style={{ maxWidth: 760, margin: '0 auto', padding: 24 }}>
            <h1 style={{ fontSize: 22 }}>精校：{book} / {vol}</h1>
            <p style={{ color: '#666' }}>请对照原叶裁图，告诉我们每格是什么字。共 {cells.length} 格待审，你已回应 {doneCount} 格。意见匿名收集，仅供校勘参考。</p>
            {cells.length === 0 && <p>这一册的待审格已清空，谢谢！</p>}
            <ul style={{ padding: 0 }}>
                {slice.map(cell => {
                    const crop = resolveCrop(cell, cord);
                    return <CellRow key={cell.a} cell={cell} crop={crop} imageUrl={crop ? images.get(crop.seq) ?? null : null} spriteSrc={spriteOf(cell)} spriteBase={spriteBase} onSpriteFail={onSpriteFail} done={done[cell.a]} onSubmit={onSubmit} />;
                })}
            </ul>
            {pages > 1 && (
                <nav style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                    <button type="button" disabled={cur === 0} onClick={() => setPage(cur - 1)}>上一页</button>
                    <span>{cur + 1} / {pages}</span>
                    <button type="button" disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)}>下一页</button>
                </nav>
            )}
        </main>
    );
}
