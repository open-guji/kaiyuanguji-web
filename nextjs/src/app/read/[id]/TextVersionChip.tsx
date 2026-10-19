'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useConvert } from 'book-index-ui';

export interface TextVersions {
    /** 文本线（章条目 text_version） */
    text: string;
    /** 标点线（punct_version），没有为 undefined */
    punct?: string;
    /** 专名线（entity_version），没有为 undefined */
    entity?: string;
}

const VERSION_RE = /^\d+\.\d+\.\d+$/;

/** 章条目里的三条版本线；文本线不合口径就整体不出（只有本项目自做的 original 版本记版本号） */
export function textVersionsOf(chapter: unknown): TextVersions | undefined {
    const c = (chapter ?? {}) as { text_version?: unknown; punct_version?: unknown; entity_version?: unknown };
    const ok = (v: unknown) => (typeof v === 'string' && VERSION_RE.test(v) ? v : undefined);
    const text = ok(c.text_version);
    if (!text) return undefined;
    return { text, punct: ok(c.punct_version), entity: ok(c.entity_version) };
}

/** 主版本号＝质量等级（book-text docs/VERSIONING.md） */
function gradeOf(v: string): string {
    const major = Number(v.split('.')[0]);
    if (major >= 3) return '定本';
    if (major === 2) return '出版级';
    if (major === 1) return '可用';
    return '校对中';
}

/**
 * 阅读器书名栏里的「文本 v0.1.4」。标点、专名的版本默认收着：
 * 鼠标悬停或点按（触屏）展开一个小浮层，列三条线的版本号。浮层用 position: fixed，免得被书名栏的 overflow 裁掉；
 * 书名栏是 <p>，所以浮层里一律用 span（不放 div／dl）。
 */
export default function TextVersionChip({ versions }: { versions: TextVersions }) {
    const { convert } = useConvert();
    const btn = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false);
    const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
    const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    const place = useCallback(() => {
        const r = btn.current?.getBoundingClientRect();
        if (!r) return;
        const width = 220;
        const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
        setPos({ top: r.bottom + 6, left });
    }, []);

    useLayoutEffect(() => { if (open) place(); }, [open, place]);
    useEffect(() => {
        if (!open) return;
        const close = (e: Event) => {
            if (e.type === 'keydown' && (e as KeyboardEvent).key !== 'Escape') return;
            if (e.type === 'pointerdown' && btn.current?.contains(e.target as Node)) return;
            if (e.type === 'pointerdown' && (e.target as Element | null)?.closest?.('[data-kyg-ver-pop]')) return;
            setOpen(false);
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

    const hoverable = () => typeof window !== 'undefined' && (window.matchMedia?.('(hover: hover)').matches ?? false);
    const enter = () => {
        if (!hoverable()) return;
        if (hoverTimer.current) clearTimeout(hoverTimer.current);
        setOpen(true);
    };
    const leave = () => {
        if (!hoverable()) return;
        if (hoverTimer.current) clearTimeout(hoverTimer.current);
        hoverTimer.current = setTimeout(() => setOpen(false), 150);
    };

    const rows: Array<[string, string | undefined]> = [
        ['文本', versions.text],
        ['标点', versions.punct],
        ['专名', versions.entity],
    ];

    return (
        <>
            <button
                ref={btn}
                type="button"
                data-testid="text-version"
                aria-expanded={open}
                aria-haspopup="dialog"
                onClick={() => setOpen((o) => !o)}
                onMouseEnter={enter}
                onMouseLeave={leave}
                className="kyg-ver-chip"
                style={{
                    font: 'inherit', fontSize: 12, lineHeight: '18px', padding: '0 6px', borderRadius: 4, cursor: 'pointer',
                    border: '1px solid var(--color-tint-2, rgba(0,0,0,.12))', background: 'transparent', color: 'var(--color-ink-2, #666)',
                    whiteSpace: 'nowrap',
                }}
            >
                {convert(`文本 v${versions.text}`)}
            </button>
            {open && pos && (
                <span
                    role="dialog"
                    aria-label={convert('版本号')}
                    data-kyg-ver-pop=""
                    data-testid="text-version-pop"
                    onMouseEnter={enter}
                    onMouseLeave={leave}
                    style={{
                        position: 'fixed', top: pos.top, left: pos.left, width: 220, zIndex: 1000, padding: '10px 12px',
                        display: 'block', whiteSpace: 'normal', borderRadius: 8, fontSize: 13, lineHeight: 1.6,
                        background: 'var(--color-paper, #fff)', color: 'var(--color-ink, #222)',
                        border: '1px solid var(--color-tint-2, rgba(0,0,0,.12))', boxShadow: '0 6px 20px rgba(0,0,0,.12)',
                    }}
                >
                    {rows.map(([label, v]) => (
                        <span key={label} style={{ display: 'flex', gap: 12, fontSize: 13 }}>
                            <span style={{ width: 32, fontSize: 13, color: 'var(--color-ink-2, #666)' }}>{convert(label)}</span>
                            <span style={{ fontSize: 13, color: 'var(--color-ink, #222)', fontVariantNumeric: 'tabular-nums' }}>{v ? `v${v}` : '—'}</span>
                        </span>
                    ))}
                    <span style={{ display: 'block', marginTop: 8, fontSize: 12, color: 'var(--color-ink-3, #888)' }}>
                        {convert(`本章文本${gradeOf(versions.text)}。三项各自记版本，改字、改标点、改专名分别升号。`)}
                    </span>
                </span>
            )}
        </>
    );
}
