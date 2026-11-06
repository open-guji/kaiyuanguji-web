'use client';

import type { CompareItem } from '@/lib/compare/compare';
import { CAT_NAME } from '@/lib/compare/decorate';
import { CAT_COLOR } from './cat-colors';

/** 格位 `页:列:序[子列]` → 「第 6 頁 第 3 列 第 10 字」 */
export function anchorLabel(anchor: string): string {
    const m = /^(\d+):(\d+):(-?\d+)/.exec(anchor);
    return m ? `第${m[1]}頁 第${m[2]}列 第${m[3]}字` : anchor;
}

function Ctx({ before, mid, after, color, ins }: { before: string; mid: string; after: string; color: string; ins?: boolean }) {
    return (
        <div style={{ lineHeight: 1.9, letterSpacing: '.04em' }}>
            <span style={{ color: 'var(--color-ink-2, #777)' }}>{before}</span>
            {mid ? <span style={{ color, borderBottom: `2px solid ${color}`, fontWeight: 600 }}>{mid}</span> : ins ? <span style={{ borderLeft: `2px solid ${color}`, margin: '0 1px' }} /> : <span style={{ color, opacity: 0.8 }}>（無）</span>}
            <span style={{ color: 'var(--color-ink-2, #777)' }}>{after}</span>
        </div>
    );
}

/**
 * 对校的底部条与详情卡：条上显示各类条数与「上一处／下一处」；点了某处（或跳到某处）出详情卡，
 * 桌面在右下角，手机（<640px）贴底成抽屉。纯展示，焦点与跳转由宿主处理。
 */
export default function CompareOverlay({ shown, current, counts, onStep, onClose, onExit, convert = (s) => s }: {
    /** 当前设置下显示的条目 */
    shown: readonly CompareItem[];
    current: CompareItem | null;
    /** 当前显示的各类条数，用于条上的摘要（按 key 顺序） */
    counts: { cat: keyof typeof CAT_NAME; n: number }[];
    onStep: (dir: 1 | -1) => void;
    /** 关详情卡 */
    onClose: () => void;
    /** 退出对校 */
    onExit: () => void;
    convert?: (s: string) => string;
}) {
    const color = current ? CAT_COLOR[current.cat] : 'inherit';
    const idx = current ? shown.findIndex((i) => i.id === current.id) : -1;
    return (
        <div data-testid="compare-overlay" style={{ position: 'fixed', zIndex: 40, left: 8, right: 8, bottom: 8, display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8, pointerEvents: 'none' }}>
            {current && (
                <section
                    role="dialog"
                    aria-label={convert('差異詳情')}
                    data-testid="compare-detail"
                    style={{
                        pointerEvents: 'auto', width: 'min(100%, 360px)', boxSizing: 'border-box', padding: '12px 14px', borderRadius: 12, fontSize: 14,
                        background: 'var(--color-paper, #fff)', color: 'var(--color-ink, #222)', border: '1px solid var(--color-tint-2, rgba(0,0,0,.15))', boxShadow: '0 8px 30px rgba(0,0,0,.2)',
                    }}
                >
                    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
                        <b style={{ color }}>{convert(CAT_NAME[current.cat])}</b>
                        <span style={{ fontSize: 12, color: 'var(--color-ink-2, #777)' }}>
                            {current.volNo ? `${convert('卷')}${current.volNo} · ` : ''}{convert(anchorLabel(current.anchor.start))}
                        </span>
                        <button type="button" aria-label={convert('關閉')} onClick={onClose} style={{ border: 0, background: 'none', fontSize: 20, lineHeight: 1, cursor: 'pointer', color: 'inherit' }}>×</button>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--color-ink-2, #777)' }}>{convert('底本')}</div>
                    <Ctx before={current.ctx.base[0]} mid={current.base} after={current.ctx.base[1]} color={color} ins={current.type === 'ins'} />
                    <div style={{ fontSize: 12, color: 'var(--color-ink-2, #777)', marginTop: 6 }}>{convert('對照本')}</div>
                    <Ctx before={current.ctx.reading[0]} mid={current.reading} after={current.ctx.reading[1]} color={color} />
                </section>
            )}
            <div
                style={{
                    pointerEvents: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '6px 10px', borderRadius: 999, fontSize: 13,
                    background: 'var(--color-paper, #fff)', border: '1px solid var(--color-tint-2, rgba(0,0,0,.15))', boxShadow: '0 2px 10px rgba(0,0,0,.12)',
                }}
            >
                <span aria-live="polite" style={{ display: 'flex', gap: 8 }}>
                    {counts.map((c) => (
                        <span key={c.cat} style={{ color: CAT_COLOR[c.cat] }}>{convert(CAT_NAME[c.cat])} {c.n}</span>
                    ))}
                </span>
                {idx >= 0 && <span style={{ color: 'var(--color-ink-2, #777)' }}>{idx + 1}/{shown.length}</span>}
                <button type="button" onClick={() => onStep(-1)} disabled={shown.length === 0} style={btn}>{convert('上一處')}</button>
                <button type="button" onClick={() => onStep(1)} disabled={shown.length === 0} style={btn}>{convert('下一處')}</button>
                <button type="button" onClick={onExit} style={btn}>{convert('退出對校')}</button>
            </div>
        </div>
    );
}

const btn = { padding: '2px 10px', borderRadius: 6, border: '1px solid var(--color-tint-2, rgba(0,0,0,.25))', background: 'transparent', color: 'inherit', font: 'inherit', cursor: 'pointer' } as const;
