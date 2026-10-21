'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { createTextApi } from 'book-index-ui';
import LayoutWrapper from '@/components/layout/LayoutWrapper';
import ProofHeader, { type ProofBookInfo } from '@/components/proof/ProofHeader';
import { readerPath } from '@/lib/reader-route';
import { getTransport } from '@/lib/transport';
import { useSource } from '@/components/common/SourceContext';
import { getJson } from '@/lib/duidu-data';
import { loadFacsimile } from '@/lib/facsimile';
import { canShow, cpLabel, shownZi } from '@/lib/zi-display';
import {
    LACUNA, classLabel, loadCosPending, contextAround, cropRect, getAid, loadProofing, pageColOf, positionIndex, preselect, readDone,
    refOpLabel, resolveCrop, shownCandidates, ctxWorthShowing, spriteUrl, submitReview, whyLabels, writeDone, boxInCrop, SYMBOLS,
    type Box, type CellContext, type CordIndex, type DoneMap, type PendingCell, type ReadSlot, type ReviewChoice, type ShownCand, type SpriteRef,
    loadProofIndex, proofState,
    ALT_SHOW, type AltCand, pickFields, type Pick,
} from '@/lib/proofing';

/** 书影一页：阅读档、原图档地址与像素宽高 */
interface FacsPage { url: string; hires: string; width: number; height: number }

const PAGE_SIZE = 20;
const BOOK_RE = /^[A-Za-z0-9_-]{1,64}$/;

// 「jiazhu」下游写的是「小注被当成正文切了」的切分缺陷（web_opinions.py），所以按钮照这个意思写，
// 别让读者在真正的夹注格上点它表示「对，这是夹注」（GUJI-683，调研 A C1）
const OTHER_CHOICES: { choice: Exclude<ReviewChoice, 'char'>; label: string; title: string; key: string }[] = [
    { choice: 'none', label: '图上没有字', title: '这一格是空白、污点、框线或印章，不是字（快捷键 n）', key: 'n' },
    { choice: 'unsure', label: '看不清', title: '图太模糊，判断不了（快捷键 u）', key: 'u' },
    { choice: 'cut', label: '切分错了', title: '这一格切得不对：字只切到一半，或混进了别的字；看出是什么字可以先写在「另写一字」框里（快捷键 c）', key: 'c' },
    { choice: 'jiazhu', label: '小注被当成正文切了', title: '这里其实是双行小注，却被当成一个大字切了（快捷键 z）', key: 'z' },
];

/**
 * 快捷键（与控制台定字卡同一套，调研 A D1）：1–9 选当前卡的第几个候选，n／u／c／z 四档，j／k 下一张／上一张。
 * 输入框里打字时不触发。按键落到「当前选中的卡」上带 data-hotkey 的按钮，等于点它。
 */
export function hotkeyTarget(key: string): string | null {
    if (/^[1-9]$/.test(key)) return key;
    return OTHER_CHOICES.some(o => o.key === key) ? key : null;
}

/** 按钮外观：都有边框和底色，一眼看得出能点；选中的绿框绿底 */
type BtnKind = 'cand' | 'act' | 'primary' | 'small';
function btnStyle(kind: BtnKind, on = false, disabled = false): React.CSSProperties {
    const base: React.CSSProperties = {
        border: '1px solid #b8ad9a', borderRadius: 6, background: '#fff', color: '#333', cursor: disabled ? 'default' : 'pointer',
        padding: '3px 10px', fontSize: 14, lineHeight: 1.4, boxShadow: '0 1px 0 rgba(0,0,0,0.06)', opacity: disabled ? 0.45 : 1,
    };
    if (kind === 'cand') Object.assign(base, { fontSize: 22, padding: '2px 10px', minWidth: 52, background: '#fffdf7' });
    if (kind === 'primary') Object.assign(base, { background: '#7a3b1d', borderColor: '#7a3b1d', color: '#fff' });
    if (kind === 'small') Object.assign(base, { fontSize: 12, padding: '1px 8px' });
    if (on) Object.assign(base, { border: '2px solid #2a7', background: '#e6f5ec', color: '#1b6b44' });
    return base;
}
const BTN_CLASS = 'hover:brightness-95 active:brightness-90 disabled:hover:brightness-100';

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

/** 只负责把原叶图的一块画出来，不读回像素。裁图带四周方便认字，红框标出这一格实际识别的范围（用户 2026-10-20） */
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
            const c = { box: [bx, by, bw, bh] as [number, number, number, number], seq: '', canvasWidth: cw };
            const [sx, sy, sw, sh] = cropRect(c, img.naturalWidth, img.naturalHeight);
            const scale = Math.min(2, 160 / Math.max(sw, sh));
            cv.width = Math.max(1, Math.round(sw * scale));
            cv.height = Math.max(1, Math.round(sh * scale));
            const g = cv.getContext('2d');
            if (!g) return;
            g.drawImage(img, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
            const [ix, iy, iw, ih] = boxInCrop(c, img.naturalWidth, img.naturalHeight).map(n => n * scale);
            g.strokeStyle = 'rgba(221,51,51,0.9)';
            g.lineWidth = 2;
            g.strokeRect(ix - 1, iy - 1, iw + 2, ih + 2);
        });
        return () => { cancelled = true; };
    }, [src, bx, by, bw, bh, cw]);
    if (failed) return <div style={{ color: '#999', fontSize: 12 }}>原图加载失败</div>;
    return <canvas ref={ref} aria-label="原叶裁图（红框是这一格）" style={{ maxWidth: 160, maxHeight: 160, background: '#eee' }} />;
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
    onSubmit: (cell: PendingCell, choice: ReviewChoice, char?: string, pick?: Pick, note?: string) => Promise<string | null>;
    context: CellContext | null;
    pendingSet: Set<string>;
    selected: boolean;
    onSelect: (a: string) => void;
}

// 向下取整：0.997 写 99%，不写成 100% 让人以为机器很有把握
const pct = (n: number) => `${Math.floor(n * 100)}%`;

/** 一个字：本站字体显示不出来（私用区、Unicode 18 以后的新字等）就显示码位 U+XXXXX，悬停看原字（lib/zi-display） */
function Zi({ c }: { c: string }) {
    if (canShow(c)) return <>{c}</>;
    return <span data-testid="zi-cp" title={c} style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '0.55em', letterSpacing: 0 }}>{cpLabel(c)}</span>;
}
/** 一串字里显示不出来的逐个换成码位（拼进句子、提示里用） */
const zis = (s: string) => [...s].map(shownZi).join('');

function CandButton({ cd, busy, picked, onPick, hotkey }: { cd: ShownCand; busy: boolean; picked: boolean; onPick: (c: string) => void; hotkey?: string }) {
    const fromRef = cd.src?.includes('ref');
    const tip = [fromRef ? `整理本这里作「${shownZi(cd.c)}」` : '', cd.score !== undefined ? `和本书别处的「${shownZi(cd.c)}」字形相似 ${pct(cd.score)}` : ''].filter(Boolean).join('；') || `选「${shownZi(cd.c)}」`;
    return (
        <button type="button" disabled={busy} aria-pressed={picked} aria-label={canShow(cd.c) ? undefined : `选「${cd.c}」`} onClick={() => onPick(cd.c)}
            title={hotkey ? `${tip}（快捷键 ${hotkey}）` : tip} className={BTN_CLASS} data-hotkey={hotkey} style={btnStyle('cand', picked, busy)}>
            <Zi c={cd.c} />
            {fromRef && <small data-testid="cand-ref" style={{ fontSize: 10, color: picked ? 'inherit' : '#7a3b1d', marginLeft: 6 }}>整理本</small>}
            {cd.score !== undefined && <small style={{ fontSize: 10, color: picked ? 'inherit' : '#888', marginLeft: 6 }}>像 {pct(cd.score)}</small>}
        </button>
    );
}

/** 字形比对一句话：拿本书别处已认定的字来比 */
function shapeSentence(cell: PendingCell): string | null {
    const top = cell.libTop ?? [];
    const v = cell.lib?.verdict;
    if (!top.length && !v) return null;
    const [a, b] = top;
    if (v === 'same' && a) return `和本书别处的「${shownZi(a.c)}」写法一致`;
    if (v === 'diff') return a ? `和本书别处已认出的字都不太像，最接近「${shownZi(a.c)}」` : '和本书别处已认出的字都不太像';
    if (a && b && b.s >= a.s - 0.05) return `和本书别处的「${shownZi(a.c)}」「${shownZi(b.c)}」都很像，分不出是哪个`;
    return a ? `最像本书别处的「${shownZi(a.c)}」，但把握不大` : null;
}

/** 机器怎么看这一格：两句话常显，其余收在「更多机器判断」里。全用大白话，不出现术语、缩写和英文 */
function Evidence({ cell }: { cell: PendingCell }) {
    const summary: React.ReactNode[] = [];
    const shape = shapeSentence(cell);
    if (shape) summary.push(<div key="lib"><b>比字形</b>：{shape}</div>);
    if (cell.ctx && ctxWorthShowing(cell)) summary.push(<div key="ctx"><b>看前后文</b>：{cell.ctx.c ? `应是「${zis(cell.ctx.c)}」` : '看不出是哪个字'}</div>);
    if (cell.ocr?.length) summary.push(<div key="ocr"><b>文字识别</b>：读作{cell.ocr.map(o => `「${zis(o.c)}」`).join('')}</div>);
    const rows: [string, React.ReactNode][] = [];
    if (cell.cls) {
        const k = classLabel(cell.cls);
        rows.push(['属于哪一类', <>{k.name}{k.hint ? <span style={{ color: '#888' }}>：{k.hint}</span> : null}</>]);
    }
    if (cell.libTop?.length) rows.push(['字形最像的几个字', cell.libTop.filter(x => x.s > 0).map(x => `「${zis(x.c)}」${pct(x.s)}`).join('　')]);
    if (cell.ref) {
        const how = cell.ref.op ? refOpLabel(cell.ref.op) : '';
        rows.push(['整理本', `这里作「${zis(cell.ref.c)}」${how ? `（${how}）` : ''}`]);
    }
    if (cell.stale) rows.push(['以前的判断', `${cell.stale.ts ? `${cell.stale.ts.slice(0, 10)} ` : ''}判为「${zis(cell.stale.c)}」，${cell.stale.state === 'withdrawn' ? '后来发现判错了位置，已撤回' : '后来切字有变动，需要重新确认'}`]);
    if (cell.occ) rows.push(['遮挡', cell.occ.refBlank ? '被印章或污渍遮住，整理本这里没有字' : `被印章或污渍遮住${cell.occ.c ? `，整理本作「${zis(cell.occ.c)}」` : ''}`]);
    if (!summary.length && !rows.length) return null;
    return (
        <div data-testid="evidence" style={{ marginTop: 8, fontSize: 12, color: '#555', lineHeight: 1.7 }}>
            {summary}
            {rows.length > 0 && (
                <details style={{ marginTop: 2 }}>
                    <summary style={{ cursor: 'pointer', color: '#7a3b1d' }}>更多机器判断</summary>
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
            pieces.push(<mark key={slot.a} data-testid="ctx-at" style={{ background: 'none', border: '2px solid #d33', padding: '0 2px', color: 'inherit' }}>{slot.c && slot.c !== LACUNA ? <Zi c={slot.c} /> : '？'}</mark>);
        } else if (pendingSet.has(slot.a)) {
            pieces.push(<span key={slot.a} title={`格 ${slot.a} 也在待审`} style={{ color: '#c70' }}>{slot.c && slot.c !== LACUNA ? <Zi c={slot.c} /> : '？'}</span>);
        } else {
            pieces.push(<span key={slot.a} title={`格 ${slot.a}`}>{slot.c ? <Zi c={slot.c} /> : '□'}</span>);
        }
    };
    ctx.before.forEach(s => push(s, false));
    push({ a: at, c: atChar ?? '' }, true);
    ctx.after.forEach(s => push(s, false));
    return (
        <div data-testid="context" style={{ marginTop: 8, fontSize: 18, letterSpacing: 2, lineHeight: 1.6 }}>
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
        <div data-testid="examples" style={{ marginTop: 8, fontSize: 12, color: '#555' }}>
            本书别处这几个字的样子
            {shown.map(([ch, list]) => (
                <div key={ch} style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                    <b style={{ fontSize: 16 }}>{ch}</b>
                    {list.map((sp, i) => (
                        <div key={i} role="img" aria-label={`「${ch}」例 ${i + 1}`}
                            style={{ width: sp.w, height: sp.h, border: '1px solid #ddd', background: `#fff url(${spriteBase(sp.s)}) -${sp.x}px -${sp.y}px no-repeat` }} />
                    ))}
                </div>
            ))}
        </div>
    );
}

/**
 * 相似字（以字找字）：近似字的异体族按这格字图排好的前几名，带字体字形图（扩展区字不靠读者电脑的字体）。
 * 缺省展开 ALT_SHOW 个，其余点「再看」。点一个就提交，和候选按钮一样。数据在出待审单时算好，这里只显示。
 */
function AltGrid({ alt, spriteBase, busy, done, onPick }: {
    alt: AltCand[]; spriteBase: (s: string) => string | null; busy: boolean; done?: string; onPick: (c: string, pick: Pick) => void;
}) {
    const [all, setAll] = useState(false);
    const [bad, setBad] = useState<Set<string>>(new Set());
    const urlKey = [...new Set(alt.map(a => (a.g ? spriteBase(a.g.s) : null)).filter((u): u is string => !!u))].join('\n');
    useEffect(() => {
        let cancelled = false;
        // 字形图没传到桶（或加载失败）就只显示字，不留空白框
        (urlKey ? urlKey.split('\n') : []).forEach(u => loadImage(u).then(img => { if (!cancelled && !img) setBad(prev => (prev.has(u) ? prev : new Set(prev).add(u))); }));
        return () => { cancelled = true; };
    }, [urlKey]);
    const shown = all ? alt : alt.slice(0, ALT_SHOW);
    return (
        <div data-testid="alt-grid" style={{ marginTop: 8 }}>
            <div style={{ fontSize: 12, color: '#555', marginBottom: 4 }}>相似字（按和这格字图的相像程度排，点一个就提交）</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {shown.map((a, i) => {
                    const u = a.g ? spriteBase(a.g.s) : null;
                    const img = a.g && u && !bad.has(u) ? a.g : null;
                    const picked = done === `「${a.c}」`;
                    const tip = [a.p && a.p !== a.c ? `从「${shownZi(a.p)}」查到` : '', a.s !== undefined ? `像 ${pct(a.s)}` : '', canShow(a.c) ? '' : cpLabel(a.c)].filter(Boolean).join('，') || `选「${a.c}」`;
                    return (
                        <button key={a.c} type="button" disabled={busy} aria-pressed={picked} aria-label={`选「${a.c}」`} title={tip}
                            onClick={() => onPick(a.c, { src: 'alt', rank: i + 1, ...(a.p ? { pivot: a.p } : {}) })} className={BTN_CLASS}
                            style={{ ...btnStyle('cand', picked, busy), display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: 4, minWidth: 48, minHeight: 48 }}>
                            {/* 只出一个字：有字体字形图（扩展区字不靠读者电脑的字体）就用图，没有才用文字；不再在下面重复一个小字 */}
                            {img
                                ? <span role="img" aria-hidden style={{ width: img.w, height: img.h, zoom: 0.42, background: `#fff url(${u}) -${img.x}px -${img.y}px no-repeat` }} />
                                : <span style={{ fontSize: 24, lineHeight: '40px' }}><Zi c={a.c} /></span>}
                        </button>
                    );
                })}
                {alt.length > ALT_SHOW && (
                    <button type="button" onClick={() => setAll(v => !v)} aria-expanded={all} className={BTN_CLASS} style={btnStyle('small')}>
                        {all ? '收起' : `再看 ${alt.length - ALT_SHOW} 个`}
                    </button>
                )}
            </div>
        </div>
    );
}

function CellRow({ cell, spriteSrc, spriteBase, onSpriteFail, imageUrl, crop, done, onSubmit, context, pendingSet, selected, onSelect }: CellRowProps) {
    const [custom, setCustom] = useState('');
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState<string | null>(null);
    const [showMore, setShowMore] = useState(false);
    const pre = useMemo(() => preselect(cell), [cell]);
    const go = async (choice: ReviewChoice, char?: string, pick?: Pick) => {
        setBusy(true);
        setErr(null);
        const e = await onSubmit(cell, choice, char, pick, note.trim() || undefined);
        setBusy(false);
        if (e) setErr(e);
    };
    const { top, more } = shownCandidates(cell);
    const preCand = pre?.choice === 'char' ? pre.char : undefined;
    const why = whyLabels(cell.why);
    const preNone = pre?.choice === 'none';
    // 切坏格（GUJI-624）：字块图不完整，卡片先给书影裁图（带四周），提示直接写字
    const segDefect = cell.cls === 'seg_defect';
    return (
        <li id={`cell-${cell.a}`} data-testid="cell-card" data-selected={selected ? '1' : undefined}
            onClickCapture={() => onSelect(cell.a)} onFocusCapture={() => onSelect(cell.a)}
            style={{ position: 'relative', border: selected ? '2px solid #d33' : '1px solid #ddd', borderRadius: 6, padding: selected ? 11 : 12, marginBottom: 12, listStyle: 'none', opacity: done && !selected ? 0.6 : 1, scrollMarginTop: 96 }}>
            {/* 提交过：右上角一个徽标就够，选了哪个看高亮的按钮（用户 2026-10-20） */}
            {done && <span data-testid="done-badge" title={`已提交：${zis(done)}，想改再点别的`}
                style={{ position: 'absolute', top: 8, right: 8, fontSize: 12, lineHeight: 1.5, padding: '0 8px', borderRadius: 10, background: '#e6f5ec', color: '#1b6b44', border: '1px solid #2a7' }}>已提交</span>}
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                {segDefect && imageUrl && crop ? <CellCrop src={imageUrl} crop={crop} />
                    : spriteSrc && cell.img ? <SpriteCrop url={spriteSrc} sprite={cell.img} label="字块裁图" onFail={onSpriteFail} />
                    : imageUrl && crop ? <CellCrop src={imageUrl} crop={crop} /> : <div style={{ color: '#999', fontSize: 12 }}>（没有这一格的图）</div>}
                <div>
                    <div style={{ fontSize: 12, color: '#666', paddingRight: 56 }}>{cellPlace(cell.a)}{cell.c ? '　机器读作' : ''}</div>
                    {/* 机器没定出字时不放大「？」，免得和下面「比字形：最像 X」打架（GUJI-683） */}
                    {cell.c ? <div style={{ fontSize: 34, lineHeight: 1.2 }}><Zi c={cell.c} /></div>
                        : <div data-testid="no-machine-char" style={{ fontSize: 13, color: '#888', marginTop: 6 }}>机器没定出字，请看图从下面选或写</div>}
                    {cell.ref && <div style={{ fontSize: 12, color: '#666' }}>整理本作「{zis(cell.ref.c)}」</div>}
                </div>
            </div>
            {context && <ContextLine ctx={context} at={cell.a} atChar={cell.c} pendingSet={pendingSet} />}
            {(cell.why?.some(w => w !== 'none') || !!cell.cls) && (
                <div data-testid="why" style={{ marginTop: 6, fontSize: 12, color: '#a60' }}>原因：{why.join('；')}</div>
            )}
            <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                {top.map((cd, i) => <CandButton key={cd.c} cd={cd} busy={busy} hotkey={String(i + 1)} picked={done ? done === `「${cd.c}」` : cd.c === preCand} onPick={c => go('char', c, { src: 'cand', rank: i + 1 })} />)}
                {showMore && more.map((cd, i) => <CandButton key={cd.c} cd={cd} busy={busy} hotkey={top.length + i + 1 <= 9 ? String(top.length + i + 1) : undefined} picked={done ? done === `「${cd.c}」` : cd.c === preCand} onPick={c => go('char', c, { src: 'cand', rank: top.length + i + 1 })} />)}
                {more.length > 0 && (
                    <button type="button" onClick={() => setShowMore(v => !v)} aria-expanded={showMore} className={BTN_CLASS} style={btnStyle('small')}>{showMore ? '收起' : `还有 ${more.length} 个`}</button>
                )}
                {cell.c && !top.some(cd => cd.c === cell.c) && !more.some(cd => cd.c === cell.c) && (
                    <button type="button" disabled={busy} aria-label={canShow(cell.c) ? undefined : `选「${cell.c}」`} onClick={() => go('char', cell.c, { src: 'machine' })} className={BTN_CLASS} style={btnStyle('cand', done === `「${cell.c}」`, busy)}><Zi c={cell.c} /></button>
                )}
                <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', marginLeft: 8 }}>
                    <input value={custom} onChange={e => setCustom(e.target.value)} placeholder={segDefect ? '看书影，写出这个字' : '都不对？写一个字'} aria-label="另写一字"
                        style={{ width: 140, fontSize: 14, padding: '4px 8px', border: '1px solid #b8ad9a', borderRadius: 6, background: '#fff' }} />
                    <button type="button" disabled={busy || [...custom].length !== 1} onClick={() => go('char', custom, { src: 'custom' })} className={BTN_CLASS}
                        style={btnStyle('primary', false, busy || [...custom].length !== 1)}>提交这个字</button>
                </span>
            </div>
            <div data-testid="symbols" style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: '#555' }}>特殊符号</span>
                {SYMBOLS.map(sy => (
                    <button key={sy.c} type="button" disabled={busy} aria-pressed={done === `「${sy.c}」`} aria-label={`选「${sy.c}」（${sy.name}）`} title={`${sy.name}：刻本上就是这个图形`}
                        onClick={() => go('char', sy.c, { src: 'symbol' })} className={BTN_CLASS}
                        style={{ ...btnStyle('cand', done === `「${sy.c}」`, busy), fontSize: 18, minWidth: 36, padding: '0 6px' }}>{sy.c}</button>
                ))}
            </div>
            {cell.alt && cell.alt.length > 0 && <AltGrid alt={cell.alt} spriteBase={spriteBase} busy={busy} done={done} onPick={(c, pick) => go('char', c, pick)} />}
            {preCand && !done && (
                <div data-testid="preselect" style={{ marginTop: 6, fontSize: 12 }}>
                    以前有人判为「{zis(preCand)}」，后来切字有变动，请看图再确认
                    <button type="button" disabled={busy} onClick={() => go('char', preCand, { src: 'preselect' })} className={BTN_CLASS} style={{ ...btnStyle('small', false, busy), marginLeft: 8 }}>是「{zis(preCand)}」</button>
                </div>
            )}
            <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {OTHER_CHOICES.map(o => (
                    <button key={o.choice} type="button" disabled={busy} aria-pressed={preNone && o.choice === 'none'} data-hotkey={o.key}
                        // 切分错了也能同时给字：「另写一字」框里有一个字就一起带上（控制台同口径，调研 A C2）
                        onClick={() => go(o.choice, o.choice === 'cut' && [...custom].length === 1 ? custom : undefined)} className={BTN_CLASS}
                        title={o.title} style={btnStyle('act', (preNone && o.choice === 'none') || done === o.label, busy)}>{o.label}</button>
                ))}
            </div>
            <input value={note} onChange={e => setNote(e.target.value.slice(0, 500))} maxLength={500} aria-label="备注"
                placeholder="备注（可不填）：比如「是臼不是曰，看上面」，先写再点上面的按钮"
                style={{ marginTop: 8, width: '100%', maxWidth: 520, boxSizing: 'border-box', fontSize: 13, padding: '4px 8px', border: '1px solid #ddd', borderRadius: 6 }} />
            {preNone && !done && <div data-testid="preselect" style={{ marginTop: 6, fontSize: 12 }}>这一格被印章或污渍遮住，先替你选了「图上没有字」，没问题就点一下确认。</div>}
            <Evidence cell={cell} />
            <Examples cell={cell} spriteBase={spriteBase} />
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
                        <button key={z} type="button" aria-pressed={zoom === z} onClick={() => setZoom(z)} className={BTN_CLASS} style={btnStyle('small', zoom === z)}>
                            {z === 1 ? '整页' : `放大 ${z} 倍`}
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

/** 页头用的书名与作者（服务端从条目 JSON 取，见 page.ssr.tsx）；取不到为 null */
export type ProofingBookInfo = ProofBookInfo;

/** 页头：与阅读页一样先是「返回阅读」，再是书名、作者、章名（与 v1.x 的反馈页共用 ProofHeader） */
function ProofingHeader({ book, vol, info, chapterTitle, versionKey }: { book: string; vol: string; info: ProofingBookInfo | null; chapterTitle?: string; versionKey?: string }) {
    const back = readerPath(book, { key: versionKey, chapter: /^\d{3}$/.test(vol) ? vol : undefined });
    return <ProofHeader back={back} info={info} sub={chapterTitle} badge="校对中" />;
}

/** 开头说明：一句请求、三步怎么做、进度；末尾一行小字说明意见怎么用 */
function ProofingIntro({ total, done }: { total: number; done: number }) {
    const pctDone = total > 0 ? Math.round((done / total) * 100) : 0;
    const steps = ['点一张卡片，整页图上会用红框标出这个字', '看看前后文和机器的判断', '选出您看到的字，或告诉我们看不清'];
    return (
        <section data-testid="proofing-intro" className="mb-6 rounded-lg p-4 sm:p-5" style={{ backgroundColor: 'var(--color-raise)', border: '1px solid var(--color-tint-2)' }}>
            <div className="sm:flex sm:items-start sm:gap-8">
                <div className="min-w-0 flex-1">
                    <h2 className="m-0 text-[19px] font-semibold" style={{ color: 'var(--color-ink)' }}>请帮我们认几个字</h2>
                    <p className="m-0 mt-1.5 text-[15px] leading-relaxed" style={{ color: 'var(--color-ink-2)' }}>
                        这一章的文字是机器从书影上识出来的，下面这些字机器拿不准。请对照原图，告诉我们您看到的是什么字。
                    </p>
                    <ol className="m-0 mt-3 flex list-none flex-col gap-2 p-0 text-[14px] sm:flex-row sm:flex-wrap sm:gap-x-5">
                        {steps.map((t, i) => (
                            <li key={i} className="flex items-center gap-2" style={{ color: 'var(--color-ink)' }}>
                                <span aria-hidden="true" className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[12px] font-semibold"
                                    style={{ backgroundColor: 'var(--color-zhu-tint)', color: 'var(--color-zhu)', border: '1px solid var(--color-zhu)' }}>{i + 1}</span>
                                {t}
                            </li>
                        ))}
                    </ol>
                </div>
                {total > 0 && (
                    <div data-testid="proofing-progress" className="mt-4 shrink-0 sm:mt-0 sm:w-44">
                        <div className="text-[13px]" style={{ color: 'var(--color-ink-3)' }}>您已回应</div>
                        <div className="text-[22px] font-semibold" style={{ color: 'var(--color-ink)' }}>
                            {done} <span className="text-[15px] font-normal" style={{ color: 'var(--color-ink-2)' }}>/ {total} 个字</span>
                        </div>
                        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full" style={{ backgroundColor: 'var(--color-tint-2)' }}
                            role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-label="回应进度">
                            <div className="h-full rounded-full" style={{ width: `${pctDone}%`, backgroundColor: '#2a7' }} />
                        </div>
                    </div>
                )}
            </div>
            <p className="m-0 mt-4 text-[13px]" style={{ color: 'var(--color-ink-3)' }}>不用登录，意见匿名收集，供整理时参考。</p>
        </section>
    );
}

export default function ProofingClient(props: { book: string; vol: string; info?: ProofingBookInfo | null }) {
    return (
        <LayoutWrapper hideFooter>
            <Proofing {...props} />
        </LayoutWrapper>
    );
}

function Proofing({ book, vol, info = null }: { book: string; vol: string; info?: ProofingBookInfo | null }) {
    const { source } = useSource();
    const transport = useMemo(() => getTransport(source), [source]);
    const [state, setState] = useState<'loading' | 'none' | 'error' | 'unpublished' | 'ok'>('loading');
    const [rev, setRev] = useState<string | null>(null);
    const [cells, setCells] = useState<PendingCell[]>([]);
    const [clsFilter, setClsFilter] = useState<string | null>(null);
    const [cord, setCord] = useState<CordIndex | null>(null);
    const [order, setOrder] = useState<ReadSlot[]>([]);
    const [images, setImages] = useState<Map<string, FacsPage>>(new Map());
    const [pendingFile, setPendingFile] = useState<string | null>(null);
    const [spriteFail, setSpriteFail] = useState<Set<string>>(new Set());
    const [done, setDone] = useState<DoneMap>({});
    const [page, setPage] = useState(0);
    const [sel, setSel] = useState<string | null>(null);
    const [onlyOpen, setOnlyOpen] = useState(false);
    const [panelOpen, setPanelOpen] = useState(true);
    const [chapterTitle, setChapterTitle] = useState<string | undefined>(undefined);
    const [versionKey, setVersionKey] = useState<string | undefined>(undefined);

    useEffect(() => {
        if (!BOOK_RE.test(book) || !BOOK_RE.test(vol)) return setState('none');
        let cancelled = false;
        const api = createTextApi(transport);
        (async () => {
            const res = await loadProofing(
                { getManifest: id => api.getManifest(id), getIndex: (id, key) => api.getIndex(id, key), getFile: (id, key, file) => getJson(transport, id, key, file), getCosPending: (b, v) => loadCosPending(b, v) },
                book, vol,
            );
            if (cancelled) return;
            if (res.status !== 'ok') return setState(res.status);
            // 0 格只在总表明确列了这一章（n=0）时才算「已校完」；总表没列＝待审单还没发布，别骗人
            if (res.pending.cells.length === 0 && proofState(await loadProofIndex(), book, vol) === 'unknown') {
                if (!cancelled) setState('unpublished');
                return;
            }
            if (cancelled) return;
            setRev(res.pending.rev);
            setCells(res.pending.cells);
            setCord(res.cord);
            setOrder(res.order ?? []);
            setPendingFile(res.pendingFile);
            setChapterTitle(res.chapterTitle);
            setVersionKey(res.versionKey);
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

    const onSubmit = useCallback(async (cell: PendingCell, choice: ReviewChoice, char?: string, pick?: Pick, note?: string) => {
        if (!rev) return '这份待审单缺少版本号，暂时不能提交';
        const e = await submitReview({ book, vol, a: cell.a, rev, choice, ...(char ? { char } : {}), ...(cell.c ? { shown: cell.c } : {}),
            ...(note ? { note } : {}), ...(choice === 'char' ? pickFields(pick) : {}) }, getAid());
        if (e) return e;
        setDone(prev => {
            const next = { ...prev, [cell.a]: doneLabel(choice, char) };
            writeDone(rev, next);
            return next;
        });
        setAdvanceFrom(cell.a);          // 回应完自动跳到下一张没回应的（调研 A D1）
        return null;
    }, [book, vol, rev]);

    // 按类筛（GUJI-624「切坏格」一类）：单子里有两类以上才显示
    const classCounts = useMemo(() => {
        const m = new Map<string, number>();
        for (const c of cells) m.set(c.cls ?? 'other', (m.get(c.cls ?? 'other') ?? 0) + 1);
        return [...m.entries()];
    }, [cells]);
    // 「只看未回应」：已回应的格在本次翻看中先不显示（回应过的格不会因此消失，关掉就回来）
    const shown = useMemo(() => cells.filter(c => (!clsFilter || (c.cls ?? 'other') === clsFilter) && (!onlyOpen || !done[c.a])),
        [cells, clsFilter, onlyOpen, done]);
    const pages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
    const cur = Math.min(page, pages - 1);
    const slice = useMemo(() => shown.slice(cur * PAGE_SIZE, (cur + 1) * PAGE_SIZE), [shown, cur]);
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

    const goTo = useCallback((a: string) => {
        const idx = shown.findIndex(c => c.a === a);
        if (idx < 0) return;
        setPage(Math.floor(idx / PAGE_SIZE));
        setSel(a);
        setTimeout(() => document.getElementById(`cell-${a}`)?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }), 0);
    }, [shown]);

    // 回应后跳到下一张还没回应的卡；后面都回应过了就留在原地
    const [advanceFrom, setAdvanceFrom] = useState<string | null>(null);
    useEffect(() => {
        if (!advanceFrom) return;
        setAdvanceFrom(null);
        const all = cells.filter(c => !clsFilter || (c.cls ?? 'other') === clsFilter);
        const i = all.findIndex(c => c.a === advanceFrom);
        const next = all.slice(i + 1).find(c => !done[c.a]);
        if (next && shown.some(c => c.a === next.a)) goTo(next.a);
    }, [advanceFrom, cells, clsFilter, done, shown, goTo]);

    // 快捷键：输入框里不触发；1–9／n／u／c／z 点当前卡上对应的按钮，j／k 换卡
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const t = e.target as HTMLElement | null;
            if (e.ctrlKey || e.metaKey || e.altKey || (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable))) return;
            if (!selected) return;
            if (e.key === 'j' || e.key === 'k') {
                const i = shown.findIndex(c => c.a === selected);
                const nb = shown[i + (e.key === 'j' ? 1 : -1)];
                if (nb) { e.preventDefault(); goTo(nb.a); }
                return;
            }
            const hk = hotkeyTarget(e.key);
            if (!hk) return;
            const btn = document.getElementById(`cell-${selected}`)?.querySelector<HTMLButtonElement>(`button[data-hotkey="${hk}"]`);
            if (btn && !btn.disabled) { e.preventDefault(); btn.click(); }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [selected, shown, goTo]);

    // 在整页上点了别的待审格：翻到它所在的那一页卡片并滚过去
    const selectFromPage = useCallback((a: string) => {
        let idx = shown.findIndex(c => c.a === a);
        if (idx < 0) {                       // 点到筛掉的那类：回到全部
            idx = cells.findIndex(c => c.a === a);
            if (idx < 0) return;
            setClsFilter(null);
        }
        setPage(Math.floor(idx / PAGE_SIZE));
        setSel(a);
        setTimeout(() => document.getElementById(`cell-${a}`)?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }), 0);
    }, [cells, shown]);

    const header = <ProofingHeader book={book} vol={vol} info={info} chapterTitle={chapterTitle} versionKey={versionKey} />;
    const note = (t: string) => <>{header}<div className="mx-auto max-w-[1400px] px-4 py-8" style={{ color: 'var(--color-ink-2)' }}>{t}</div></>;
    if (state === 'loading') return note('加载中…');
    if (state === 'none') return note('这一章暂时没有待校对的字。');
    if (state === 'unpublished') return note('这一章的待校对名单还没有发布，请稍后再来。');
    if (state === 'error') return note('待校对的字暂时取不到，请稍后再试。');

    const doneCount = cells.filter(c => done[c.a]).length;
    const panelPage = selCrop ? images.get(selCrop.seq) ?? null : null;
    return (
        <>
        {header}
        <div className="mx-auto max-w-[1400px] px-4 py-6">
            <ProofingIntro total={cells.length} done={doneCount} />
            {cells.length === 0 && <p>这一章的字都已校完，谢谢！</p>}
            {cells.length > 0 && (
                <div className="lg:flex lg:items-start lg:gap-6">
                    <aside className="sticky top-[var(--nav-h)] z-10 mb-4 bg-[var(--color-paper)] py-2 [--proof-page-h:38vh] lg:top-[calc(var(--nav-h)+1rem)] lg:[--proof-page-h:calc(100vh-var(--nav-h)-6rem)] lg:mb-0 lg:w-[46%] lg:shrink-0 lg:py-0">
                        <button type="button" className={`lg:hidden ${BTN_CLASS}`} onClick={() => setPanelOpen(v => !v)} aria-expanded={panelOpen} style={{ ...btnStyle('small'), marginBottom: 4 }}>
                            {panelOpen ? '收起整页' : '显示整页'}
                        </button>
                        <div className={panelOpen ? '' : 'hidden lg:block'}>
                            <PagePanel page={panelPage} pageNo={selCrop ? selPageNo : null} canvasW={selCrop?.canvasWidth ?? 0} canvasH={selCrop?.canvasHeight ?? 0}
                                boxes={pageBoxes} selected={selected} onSelect={selectFromPage} fitHeight="var(--proof-page-h)" />
                        </div>
                    </aside>
                    <div className="min-w-0 lg:flex-1">
                        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8, fontSize: 13, color: '#666' }}>
                            <label style={{ display: 'inline-flex', gap: 4, alignItems: 'center', cursor: 'pointer' }}>
                                <input type="checkbox" checked={onlyOpen} onChange={e => { setOnlyOpen(e.target.checked); setPage(0); }} data-testid="only-open" />
                                只看还没回应的
                            </label>
                            <span data-testid="hotkey-hint">快捷键：1–9 选候选，n 图上没有字，u 看不清，c 切分错了，z 小注切成正文，j／k 下一张／上一张</span>
                        </div>
                        {classCounts.length > 1 && (
                            <div data-testid="class-filter" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
                                <button type="button" aria-pressed={!clsFilter} onClick={() => { setClsFilter(null); setPage(0); }} className={BTN_CLASS} style={btnStyle('small', !clsFilter)}>全部 {cells.length}</button>
                                {classCounts.map(([k, n]) => (
                                    <button key={k} type="button" aria-pressed={clsFilter === k} onClick={() => { setClsFilter(k); setPage(0); }} className={BTN_CLASS}
                                        style={btnStyle('small', clsFilter === k)}>{classLabel(k).name} {n}</button>
                                ))}
                            </div>
                        )}
                        <ul style={{ padding: 0 }}>
                            {slice.map(cell => {
                                const crop = resolveCrop(cell, cord);
                                return <CellRow key={cell.a} cell={cell} crop={crop} imageUrl={crop ? images.get(crop.seq)?.hires ?? null : null} spriteSrc={spriteOf(cell)} spriteBase={spriteBase} onSpriteFail={onSpriteFail} done={done[cell.a]} onSubmit={onSubmit}
                                    context={contextAround(order, pos, cell.a)} pendingSet={pendingSet} selected={cell.a === selected} onSelect={setSel} />;
                            })}
                        </ul>
                        {pages > 1 && (
                            <nav style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                                <button type="button" disabled={cur === 0} onClick={() => setPage(cur - 1)} className={BTN_CLASS} style={btnStyle('act', false, cur === 0)}>上一页</button>
                                <span>{cur + 1} / {pages}</span>
                                <button type="button" disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)} className={BTN_CLASS} style={btnStyle('act', false, cur >= pages - 1)}>下一页</button>
                            </nav>
                        )}
                    </div>
                </div>
            )}
        </div>
        </>
    );
}
