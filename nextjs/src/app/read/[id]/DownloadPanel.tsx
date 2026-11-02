'use client';

/**
 * 阅读器书名栏里的「下载本冊」（A33 下载方案，sheldon 11-02 定）：点开一个小浮层，选格式、专名链接、字形，
 * 浏览器里当场生成 guji-markdown 存成 .md（lib/export/）。只给本项目自做的 original 版本（有 char 的章）出。
 * 开合方式同 TextVersionChip。浮层用 portal 挂到 body：书名栏的祖先有 backdrop-filter 之类，
 * position: fixed 会以它为参照、整体下移（实测偏一百多像素）；挂到 body 也就不受书名栏 <p> 只能放行内元素的限制。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useConvert } from 'book-index-ui';
import { FORMAT_NOTE, GLYPH_NOTE, GLYPHS, HINT } from './DownloadChip';
import {
    availableFormats, buildExport, saveText, FORMAT_LABEL, GLYPH_LABEL,
    type ExportChapter, type ExportFormat, type ExportGlyph,
} from '@/lib/export/download';

import type { DownloadTarget } from './DownloadChip';


export default function DownloadPanel({ target, storage }: { target: DownloadTarget; storage: object }) {
    const { convert } = useConvert();
    const formats = availableFormats(target.chapter);
    const [format, setFormat] = useState<ExportFormat>('punct');
    const [links, setLinks] = useState(true);
    const [glyph, setGlyph] = useState<ExportGlyph>('original');
    const [busy, setBusy] = useState(false);
    const [done, setDone] = useState(false);
    const doneTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => () => { if (doneTimer.current) clearTimeout(doneTimer.current); }, []);
    const [error, setError] = useState<string | null>(null);
    const fmt = formats.includes(format) ? format : formats[formats.length - 1];

    const run = useCallback(async () => {
        if (!fmt) return;
        setBusy(true);
        setDone(false);
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

    // 手机上触控目标不小于 44px：选项行 minHeight 44，按钮 44 高
    const row = { display: 'flex', gap: 8, alignItems: 'center', minHeight: 44, fontSize: 14, cursor: 'pointer' } as const;
    const radio = (name: string, checked: boolean, onChange: () => void, label: string, note?: string, testid?: string) => (
        <label key={label} style={row}>
            <input type="radio" name={name} checked={checked} onChange={() => { onChange(); }} data-testid={testid} />
            <span style={{ whiteSpace: 'nowrap' }}>{convert(label)}</span>
            {note && <span style={{ fontSize: 12, color: 'var(--color-ink-3, #888)' }}>{convert(note)}</span>}
        </label>
    );
    const head = (t: string) => <span style={{ display: 'block', marginTop: 4, fontSize: 12, color: 'var(--color-ink-2, #666)' }}>{convert(t)}</span>;

    return (
        <div data-testid="download-panel" style={{ display: 'block', whiteSpace: 'normal', lineHeight: 1.6 }}>
            {head('格式')}
            {formats.map((f) => radio('kyg-dl-fmt', fmt === f, () => setFormat(f), FORMAT_LABEL[f], FORMAT_NOTE[f], `download-fmt-${f}`))}
            {formats.includes('entity') && (
                <label style={{ ...row, marginLeft: 22, cursor: fmt === 'entity' ? 'pointer' : 'default', opacity: fmt === 'entity' ? 1 : 0.45 }}>
                    <input type="checkbox" checked={links} disabled={fmt !== 'entity'} onChange={(e) => setLinks(e.target.checked)} data-testid="download-links" />
                    <span>{convert('帶庫內鏈接')}</span>
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
                    display: 'block', width: '100%', marginTop: 8, minHeight: 44, borderRadius: 6, fontSize: 14, cursor: busy ? 'wait' : 'pointer',
                    border: '1px solid var(--color-tint-2, rgba(0,0,0,.2))', background: 'var(--color-tint, rgba(0,0,0,.04))', color: 'var(--color-ink, #222)',
                }}
            >
                {convert(busy ? '生成中…' : done ? '已下載 ✓' : '下載 .md')}
            </button>
            {error && <span role="alert" style={{ display: 'block', marginTop: 6, fontSize: 12, color: '#b42318' }}>{convert('沒能生成：')}{error}</span>}
            <span style={{ display: 'block', marginTop: 8, fontSize: 12, color: 'var(--color-ink-3, #888)' }}>
                {convert(HINT)}
            </span>
        </div>
    );
}
