'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createTextApi } from 'book-index-ui';
import { getTransport } from '@/lib/transport';
import { useSource } from '@/components/common/SourceContext';
import { getJson } from '@/lib/duidu-data';
import { loadFacsimile } from '@/lib/facsimile';
import {
    cropRect, getAid, loadProofing, readDone, resolveCrop, submitReview, writeDone,
    type CordIndex, type DoneMap, type PendingCell, type ReviewChoice,
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
    }
    return p;
}

/** 只负责把原叶图的一块画出来，不读回像素 */
function CellCrop({ src, crop }: { src: string; crop: { box: [number, number, number, number]; canvasWidth: number } }) {
    const ref = useRef<HTMLCanvasElement>(null);
    const [failed, setFailed] = useState(false);
    useEffect(() => {
        let cancelled = false;
        loadImage(src).then(img => {
            const cv = ref.current;
            if (cancelled || !cv) return;
            if (!img) return setFailed(true);
            const [sx, sy, sw, sh] = cropRect({ ...crop, seq: '' }, img.naturalWidth, img.naturalHeight);
            const scale = Math.min(2, 160 / Math.max(sw, sh));
            cv.width = Math.max(1, Math.round(sw * scale));
            cv.height = Math.max(1, Math.round(sh * scale));
            cv.getContext('2d')?.drawImage(img, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
        });
        return () => { cancelled = true; };
    }, [src, crop]);
    if (failed) return <div style={{ color: '#999', fontSize: 12 }}>原图加载失败</div>;
    return <canvas ref={ref} aria-label="原叶裁图" style={{ maxWidth: 160, maxHeight: 160, background: '#eee' }} />;
}

interface CellRowProps {
    cell: PendingCell;
    imageUrl: string | null;
    crop: { box: [number, number, number, number]; canvasWidth: number } | null;
    done?: string;
    onSubmit: (cell: PendingCell, choice: ReviewChoice, char?: string) => Promise<string | null>;
}

function CellRow({ cell, imageUrl, crop, done, onSubmit }: CellRowProps) {
    const [custom, setCustom] = useState('');
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState<string | null>(null);
    const go = async (choice: ReviewChoice, char?: string) => {
        setBusy(true);
        setErr(null);
        const e = await onSubmit(cell, choice, char);
        setBusy(false);
        if (e) setErr(e);
    };
    const cands = cell.cand ?? [];
    return (
        <li style={{ border: '1px solid #ddd', borderRadius: 6, padding: 12, marginBottom: 12, listStyle: 'none', opacity: done ? 0.6 : 1 }}>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                {imageUrl && crop ? <CellCrop src={imageUrl} crop={crop} /> : <div style={{ color: '#999', fontSize: 12 }}>（无裁图，仅供看字）</div>}
                <div>
                    <div style={{ fontSize: 12, color: '#666' }}>格 {cell.a}　机器读作</div>
                    <div style={{ fontSize: 40, lineHeight: 1.2 }}>{cell.c || '？'}</div>
                </div>
            </div>
            <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                {cands.map(cd => (
                    <button key={cd.c} type="button" disabled={busy} onClick={() => go('char', cd.c)} title={cd.src ? `来源：${cd.src}` : undefined}
                        style={{ fontSize: 22, padding: '2px 10px' }}>{cd.c}</button>
                ))}
                {cell.c && !cands.some(cd => cd.c === cell.c) && (
                    <button type="button" disabled={busy} onClick={() => go('char', cell.c)} style={{ fontSize: 22, padding: '2px 10px' }}>{cell.c}</button>
                )}
                <input value={custom} onChange={e => setCustom(e.target.value)} placeholder="另写一字" aria-label="另写一字" style={{ width: 72 }} />
                <button type="button" disabled={busy || [...custom].length !== 1} onClick={() => go('char', custom)}>提交此字</button>
            </div>
            <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {OTHER_CHOICES.map(o => (
                    <button key={o.choice} type="button" disabled={busy} onClick={() => go(o.choice)}>{o.label}</button>
                ))}
            </div>
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
            setDone(res.pending.rev ? readDone(res.pending.rev) : {});
            setState('ok');
            // 书影页：失败不影响看字和提交
            const facs = await loadFacsimile(book, vol).catch(() => null);
            if (cancelled || !facs) return;
            setImages(new Map(facs.flatMap(f => (f.seq ? [[f.seq, f.hiresUrl ?? f.url] as [string, string]] : []))));
        })().catch(() => { if (!cancelled) setState('error'); });
        return () => { cancelled = true; };
    }, [book, vol, transport]);

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
                    return <CellRow key={cell.a} cell={cell} crop={crop} imageUrl={crop ? images.get(crop.seq) ?? null : null} done={done[cell.a]} onSubmit={onSubmit} />;
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
