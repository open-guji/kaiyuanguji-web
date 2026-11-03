'use client';

/**
 * 阅读器书名栏里的「下载本冊」（A33 下载方案，sheldon 11-02 定）：点开一个小浮层，选格式、专名链接、字形，
 * 浏览器里当场生成 guji-markdown 存成 .md（lib/export/）。只给本项目自做的 original 版本（有 char 的章）出。
 * 开合方式同 TextVersionChip。浮层用 portal 挂到 body：书名栏的祖先有 backdrop-filter 之类，
 * position: fixed 会以它为参照、整体下移（实测偏一百多像素）；挂到 body 也就不受书名栏 <p> 只能放行内元素的限制。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useConvert } from 'book-index-ui';
import {
    availableFormats, buildExport, saveText, FORMAT_LABEL, GLYPH_LABEL,
    type ExportChapter, type ExportFormat, type ExportGlyph,
} from '@/lib/export/download';

export interface DownloadTarget {
    id: string;
    versionKey: string;
    chapter: ExportChapter;
    bookTitle: string;
    versionLabel?: string;
    edition?: string;
    license?: string;
    dataVersion?: string;
}

export const FORMAT_NOTE: Record<ExportFormat, string> = {
    lines: '照原書一列一行，不加標點',
    punct: '標點、分段、標題，書名加書名號',
    entity: '再加專名號 /人名/',
};

export const GLYPH_NOTE: Record<ExportGlyph, string> = {
    original: '不改字',
    traditional: '異體字歸一',
    simplified: '歸一後轉簡',
};

export const GLYPHS: ExportGlyph[] = ['original', 'traditional', 'simplified'];
export const HINT = '古籍 Markdown（guji-format），文件開頭記書名與各項版本號；生僻字需裝相應字庫才顯示。';

export default function DownloadChip({ target, storage }: { target: DownloadTarget; storage: object }) {
    const { convert } = useConvert();
    const formats = availableFormats(target.chapter);
    const btn = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false);
    const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
    const [format, setFormat] = useState<ExportFormat>('punct');
    const [links, setLinks] = useState(true);
    const [glyph, setGlyph] = useState<ExportGlyph>('original');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [done, setDone] = useState(false);
    const pop = useRef<HTMLSpanElement>(null);
    const doneTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => () => { if (doneTimer.current) clearTimeout(doneTimer.current); }, []);
    const fmt = formats.includes(format) ? format : formats[formats.length - 1];

    const place = useCallback(() => {
        const r = btn.current?.getBoundingClientRect();
        if (!r) return;
        const width = 260;
        setPos({ top: r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)) });
    }, []);
    useLayoutEffect(() => { if (open) place(); }, [open, place]);
    // 打开时焦点落到第一个单选项（键盘用户直接上下键选）
    useEffect(() => { if (open && pos) pop.current?.querySelector<HTMLInputElement>('input')?.focus(); }, [open, pos !== null]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => {
        if (!open) return;
        const close = (e: Event) => {
            if (e.type === 'keydown' && (e as KeyboardEvent).key !== 'Escape') return;
            if (e.type === 'pointerdown' && btn.current?.contains(e.target as Node)) return;
            if (e.type === 'pointerdown' && (e.target as Element | null)?.closest?.('[data-kyg-dl-pop]')) return;
            setOpen(false);
            // 按 Esc 关的，焦点回到按钮；点外面关的不抢焦点
            if (e.type === 'keydown') btn.current?.focus();
        };
        const move = () => place();
        document.addEventListener('pointerdown', close);
        document.addEventListener('keydown', close);
        window.addEventListener('scroll', move, true);
        window.addEventListener('resize', move);
        return () => {
            document.removeEventListener('pointerdown', close);
            document.removeEventListener('keydown', close);
            window.removeEventListener('scroll', move, true);
            window.removeEventListener('resize', move);
        };
    }, [open, place]);

    const run = useCallback(async () => {
        if (!fmt) return;
        setBusy(true);
        setError(null);
        try {
            const pageUrl = typeof window !== 'undefined' ? window.location.origin + window.location.pathname : undefined;
            saveText(await buildExport({ ...target, format: fmt, links, glyph, pageUrl }, storage));
            setDone(true);
            if (doneTimer.current) clearTimeout(doneTimer.current);
            doneTimer.current = setTimeout(() => setDone(false), 2000);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    }, [fmt, links, glyph, target, storage]);

    if (!fmt) return null;

    const radio = (name: string, checked: boolean, onChange: () => void, label: string, note?: string, testid?: string) => (
        <label key={label} style={{ display: 'flex', gap: 6, alignItems: 'baseline', fontSize: 13, cursor: 'pointer' }}>
            <input type="radio" name={name} checked={checked} onChange={onChange} data-testid={testid} />
            <span style={{ fontSize: 13, whiteSpace: 'nowrap' }}>{convert(label)}</span>
            {note && <span style={{ fontSize: 12, color: 'var(--color-ink-3, #888)' }}>{convert(note)}</span>}
        </label>
    );
    const head = (t: string) => <span style={{ display: 'block', marginTop: 8, marginBottom: 2, fontSize: 12, color: 'var(--color-ink-2, #666)' }}>{convert(t)}</span>;

    return (
        <>
            <button
                ref={btn}
                type="button"
                data-testid="download-chip"
                aria-expanded={open}
                aria-haspopup="dialog"
                onClick={() => setOpen((o) => !o)}
                style={{
                    font: 'inherit', fontSize: 12, lineHeight: '18px', padding: '0 6px', borderRadius: 4, cursor: 'pointer',
                    border: '1px solid var(--color-tint-2, rgba(0,0,0,.12))', background: 'transparent', color: 'var(--color-ink-2, #666)',
                    whiteSpace: 'nowrap',
                }}
            >
                {convert('下載本冊')}
            </button>
            {open && pos && createPortal(
                <span
                    role="dialog"
                    aria-label={convert('下載本冊')}
                    ref={pop}
                    data-kyg-dl-pop=""
                    data-testid="download-pop"
                    style={{
                        position: 'fixed', top: pos.top, left: pos.left, width: 260, zIndex: 1000, padding: '10px 12px',
                        display: 'block', whiteSpace: 'normal', borderRadius: 8, fontSize: 13, lineHeight: 1.7,
                        background: 'var(--color-paper, #fff)', color: 'var(--color-ink, #222)',
                        border: '1px solid var(--color-tint-2, rgba(0,0,0,.12))', boxShadow: '0 6px 20px rgba(0,0,0,.12)',
                    }}
                >
                    {head('格式')}
                    {formats.map((f) => radio('kyg-dl-fmt', fmt === f, () => setFormat(f), FORMAT_LABEL[f], FORMAT_NOTE[f], `download-fmt-${f}`))}
                    {/* 只有专名本用得上；别的格式下置灰不隐藏，免得浮层高度跳动 */}
                    {formats.includes('entity') && (
                        <label style={{ display: 'flex', gap: 6, alignItems: 'baseline', fontSize: 13, marginLeft: 20, cursor: fmt === 'entity' ? 'pointer' : 'default', opacity: fmt === 'entity' ? 1 : 0.45 }}>
                            <input type="checkbox" checked={links} disabled={fmt !== 'entity'} onChange={(e) => setLinks(e.target.checked)} data-testid="download-links" />
                            <span style={{ fontSize: 13 }}>{convert('帶庫內鏈接')}</span>
                        </label>
                    )}
                    {head('字形')}
                    {GLYPHS.map((g) => radio('kyg-dl-glyph', glyph === g, () => setGlyph(g), GLYPH_LABEL[g], GLYPH_NOTE[g], `download-glyph-${g}`))}
                    <button
                        type="button"
                        data-testid="download-go"
                        aria-live="polite"
                        disabled={busy}
                        onClick={run}
                        style={{
                            display: 'block', width: '100%', marginTop: 10, padding: '4px 0', borderRadius: 4, fontSize: 13, cursor: busy ? 'wait' : 'pointer',
                            border: '1px solid var(--color-tint-2, rgba(0,0,0,.2))', background: 'var(--color-tint, rgba(0,0,0,.04))', color: 'var(--color-ink, #222)',
                        }}
                    >
                        {convert(busy ? '生成中…' : done ? '已下載 ✓' : '下載 .md')}
                    </button>
                    {error && <span role="alert" style={{ display: 'block', marginTop: 6, fontSize: 12, color: '#b42318' }}>{convert('沒能生成：')}{error}</span>}
                    <span
                        title={convert(HINT)}
                        data-testid="download-hint"
                        style={{
                            display: 'block', marginTop: 12, paddingTop: 6, borderTop: '1px solid var(--color-tint-2, rgba(0,0,0,.08))',
                            fontSize: 11, lineHeight: 1.5, color: 'var(--color-ink-3, #888)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        }}
                    >
                        {convert(HINT)}
                    </span>
                </span>,
                document.body,
            )}
        </>
    );
}
