'use client';

import { useEffect, useRef } from 'react';
import type { CompareItem } from '@/lib/compare/compare';
import { CAT_NAME } from '@/lib/compare/decorate';
import { CAT_COLOR } from './cat-colors';

/**
 * 阅读器的浮层容器是整个视口右下角固定的，会盖住右侧的阅读设置。这里量正文字的左右缘，
 * 把内容往左平移到正文栏右缘（只平移不改布局；窄屏贴底的版式不动）。
 */
function useClampToText(ref: React.RefObject<HTMLElement | null>) {
    useEffect(() => {
        let raf = 0;
        const apply = () => {
            raf = 0;
            const el = ref.current;
            if (!el) return;
            const vw = document.documentElement.clientWidth;
            let shift = 0;
            if (vw > 720) {
                const chars = document.querySelectorAll('.guji-text-char');
                let right = 0;
                const step = Math.max(1, Math.floor(chars.length / 60));
                for (let i = 0; i < chars.length; i += step) {
                    const r = chars[i].getBoundingClientRect();
                    if (r.width > 0 && r.right > right) right = r.right;
                }
                // 浮层右缘默认距视口 16px；正文右缘再留 16px 边
                if (right > 0 && right + 16 < vw - 16) shift = vw - 16 - (right + 16);
            }
            el.style.position = 'relative';
            el.style.right = `${shift}px`;
        };
        const sched = () => { if (!raf) raf = requestAnimationFrame(apply); };
        apply();
        window.addEventListener('resize', sched);
        window.addEventListener('scroll', sched, { passive: true });
        const t = window.setInterval(sched, 600); // 阅读设置开合、栏宽变化没有事件
        return () => { window.removeEventListener('resize', sched); window.removeEventListener('scroll', sched); window.clearInterval(t); if (raf) cancelAnimationFrame(raf); };
    }, [ref]);
}

/** 格位 `页:列:序[子列]` → 「第 6 頁 第 3 列 第 10 字」 */
export function anchorLabel(anchor: string): string {
    const m = /^(\d+):(\d+):(-?\d+)/.exec(anchor);
    return m ? `第${m[1]}頁 第${m[2]}列 第${m[3]}字` : anchor;
}

/** 两版的上下文照原字显示，不做繁简转换：差异本来就在字形上（異體字、𠮓/變），转了就看不出来 */
function Ctx({ before, mid, after, color, ins }: { before: string; mid: string; after: string; color: string; ins?: boolean }) {
    return (
        <div className="cmp-ctx">
            <span className="cmp-ctx-dim">{before}</span>
            {mid ? <span style={{ color, borderBottom: `2px solid ${color}`, fontWeight: 600 }}>{mid}</span> : ins ? <span style={{ borderLeft: `2px solid ${color}`, margin: '0 1px' }} /> : <span style={{ color, opacity: 0.8 }}>（無）</span>}
            <span className="cmp-ctx-dim">{after}</span>
        </div>
    );
}

/**
 * 对校的底部条与详情卡：条上显示各类条数与「上一处／下一处」；点了某处（或跳到某处）出详情卡，
 * 放哪由阅读器的插件浮层容器管（桌面右下角，手机贴底并让开底栏），这里不自己定位。纯展示，焦点与跳转由宿主处理。
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
    const box = useRef<HTMLDivElement>(null);
    useClampToText(box);
    const color = current ? CAT_COLOR[current.cat] : 'inherit';
    const idx = current ? shown.findIndex((i) => i.id === current.id) : -1;
    return (
        <div ref={box} data-testid="compare-overlay" className="cmp-stack">
            {current && (
                <section role="dialog" aria-label={convert('差異詳情')} data-testid="compare-detail" className="cmp-card" style={{ ['--c' as string]: color }}>
                    <header className="cmp-card-head">
                        <b className="cmp-card-cat">{convert(CAT_NAME[current.cat])}</b>
                        <span className="cmp-card-where">
                            {current.volNo ? `${convert('卷')}${current.volNo} · ` : ''}{convert(anchorLabel(current.anchor.start))}
                        </span>
                        <button type="button" aria-label={convert('關閉')} onClick={onClose} className="cmp-iconbtn">×</button>
                    </header>
                    <div className="cmp-card-label">{convert('底本')}</div>
                    <Ctx before={current.ctx.base[0]} mid={current.base} after={current.ctx.base[1]} color={color} ins={current.type === 'ins'} />
                    <div className="cmp-card-label">{convert('對照本')}</div>
                    <Ctx before={current.ctx.reading[0]} mid={current.reading} after={current.ctx.reading[1]} color={color} />
                </section>
            )}
            <div className="cmp-bar">
                <span aria-live="polite" className="cmp-bar-counts">
                    {counts.map((c) => (
                        <span key={c.cat} title={convert(CAT_NAME[c.cat])} aria-label={`${convert(CAT_NAME[c.cat])} ${c.n}`} className="cmp-count" style={{ ['--c' as string]: CAT_COLOR[c.cat] }}>{c.n}</span>
                    ))}
                </span>
                {idx >= 0 && <span className="cmp-bar-pos">{idx + 1}/{shown.length}</span>}
                <button type="button" onClick={() => onStep(-1)} disabled={shown.length === 0} aria-label={convert('上一處')} title={convert('上一處')} className="cmp-iconbtn">‹</button>
                <button type="button" onClick={() => onStep(1)} disabled={shown.length === 0} aria-label={convert('下一處')} title={convert('下一處')} className="cmp-iconbtn">›</button>
                <button type="button" onClick={onExit} className="cmp-exit">{convert('退出對校')}</button>
            </div>
        </div>
    );
}
