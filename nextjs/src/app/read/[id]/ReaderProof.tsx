'use client';

import { useCallback, useEffect, useMemo, useState, type RefObject } from 'react';
import { isDoubtful, isHumanChecked, isMissingChar, type ProofCell, type ProofLayer } from '@/lib/proof';

/** 偏好键：`proof=0|1`，默认 0。只有 URL 带 `?proof=` 或本机存过取值才会出现开关（D1.3 前不对外公开） */
export const PROOF_PREF_KEY = 'guji.proof';

/** 读开关状态：返回 null＝不可用（不渲染任何东西）；URL 参数优先于本机偏好 */
export function readProofPref(search: string, storage: Pick<Storage, 'getItem'> | null): boolean | null {
    const q = new URLSearchParams(search).get('proof');
    if (q === '0' || q === '1') return q === '1';
    let saved: string | null = null;
    try { saved = storage?.getItem(PROOF_PREF_KEY) ?? null; } catch { /* 无存储 */ }
    return saved === '0' || saved === '1' ? saved === '1' : null;
}

/** 浏览器端读取开关：服务端渲染与水合首帧一律 null，挂载后才定 */
export function useProofPref(): { on: boolean | null; set: (v: boolean) => void } {
    const [on, setOn] = useState<boolean | null>(null);
    useEffect(() => {
        let st: Storage | null = null;
        try { st = window.localStorage; } catch { /* 禁用存储 */ }
        setOn(readProofPref(window.location.search, st));
    }, []);
    const set = useCallback((v: boolean) => {
        setOn(v);
        try { window.localStorage.setItem(PROOF_PREF_KEY, v ? '1' : '0'); } catch { /* 忽略 */ }
    }, []);
    return { on, set };
}

const cssEsc = (s: string) => s.replace(/["\\]/g, '\\$&');

type Kind = 'doubt' | 'missing' | 'auto' | 'human';
const kindOf = (c: ProofCell): Kind =>
    isMissingChar(c) ? 'missing' : isDoubtful(c) ? 'doubt' : isHumanChecked(c) ? 'human' : 'auto';

const KIND_LABEL: Record<Kind, string> = {
    doubt: '存疑字（机器识别，待校）',
    missing: '缺字（原书遮挡或残缺）',
    auto: '机器识别，待校',
    human: '人工校过',
};

/** 默认只标「存疑字」与「缺字」；auto／human 的格子不画（公开页的默认口径） */
export function markedCells(layer: ProofLayer): ProofCell[] {
    const out: ProofCell[] = [];
    for (const c of layer.cells.values()) {
        const k = kindOf(c);
        if (k === 'doubt' || k === 'missing') out.push(c);
    }
    return out;
}

/** 标注样式：纯 CSS 属性选择器，不动阅读器的 DOM；关闭时整个组件不渲染，DOM 与现状逐字节一致 */
export function proofCss(cells: ProofCell[]): string {
    const sel = (kind: Kind) =>
        cells.filter(c => kindOf(c) === kind).map(c => `[data-char-id="${cssEsc(c.a)}"]`);
    const rules: string[] = [];
    const doubt = sel('doubt');
    const missing = sel('missing');
    if (doubt.length) rules.push(`${doubt.join(',')}{text-decoration:underline dotted #c2410c;text-underline-offset:3px;background:rgba(194,65,12,.10)}`);
    if (missing.length) rules.push(`${missing.join(',')}{background:rgba(100,116,139,.18);outline:1px dashed #64748b}`);
    rules.push('[data-char-id].proof-focus{outline:2px solid #2563eb;outline-offset:1px}');
    return rules.join('\n');
}

/**
 * 校对模式（D1.2，overview#605）：把 proof.json 的逐字识别状态叠在阅读器正文上。
 * 与阅读器的接口只有两处——字 id（`data-char-id`＝`页:列:格`）和宿主容器；不改 book-index-ui。
 * 悬停／聚焦出气泡；工具条的「上一处／下一处」让键盘也能逐个跳到存疑字。
 */
export default function ReaderProof({ layer, hostRef, on, onToggle }: {
    layer: ProofLayer;
    hostRef: RefObject<HTMLElement | null>;
    on: boolean;
    onToggle: (v: boolean) => void;
}) {
    const cells = useMemo(() => markedCells(layer), [layer]);
    const css = useMemo(() => proofCss(cells), [cells]);
    const [tip, setTip] = useState<{ cell: ProofCell; x: number; y: number } | null>(null);
    const [cursor, setCursor] = useState(-1);

    useEffect(() => {
        const host = hostRef.current;
        if (!on || !host) return;
        const find = (t: EventTarget | null) => {
            const el = (t as Element | null)?.closest?.('[data-char-id]') as HTMLElement | null;
            const cell = el ? layer.cells.get(el.getAttribute('data-char-id') ?? '') : undefined;
            return el && cell ? { el, cell } : null;
        };
        const over = (e: Event) => {
            const hit = find(e.target);
            if (!hit) { setTip(null); return; }
            const r = hit.el.getBoundingClientRect();
            setTip({ cell: hit.cell, x: r.left, y: r.bottom });
        };
        const out = () => setTip(null);
        host.addEventListener('mouseover', over);
        host.addEventListener('mouseleave', out);
        return () => { host.removeEventListener('mouseover', over); host.removeEventListener('mouseleave', out); };
    }, [on, layer, hostRef]);

    const jump = useCallback((dir: 1 | -1) => {
        const host = hostRef.current;
        if (!host || cells.length === 0) return;
        host.querySelectorAll('.proof-focus').forEach(n => n.classList.remove('proof-focus'));
        let i = cursor;
        for (let n = 0; n < cells.length; n++) {
            i = (i + dir + cells.length) % cells.length;
            const el = host.querySelector<HTMLElement>(`[data-char-id="${cssEsc(cells[i].a)}"]`);
            if (el) {
                el.classList.add('proof-focus');
                el.scrollIntoView({ block: 'center', behavior: 'smooth' });
                const r = el.getBoundingClientRect();
                setTip({ cell: cells[i], x: r.left, y: r.bottom });
                setCursor(i);
                return;
            }
        }
    }, [cells, cursor, hostRef]);

    return (
        <div data-proof-bar className="fixed bottom-4 right-4 z-40 flex items-center gap-2 rounded-lg border bg-white/95 px-3 py-2 text-sm shadow dark:bg-neutral-900/95">
            <label className="flex items-center gap-1">
                <input type="checkbox" checked={on} onChange={e => onToggle(e.target.checked)} />
                校对标注
            </label>
            {on && (
                <>
                    <span aria-live="polite">存疑 {cells.length} 处</span>
                    <button type="button" className="rounded border px-2" onClick={() => jump(-1)} disabled={cells.length === 0}>上一处</button>
                    <button type="button" className="rounded border px-2" onClick={() => jump(1)} disabled={cells.length === 0}>下一处</button>
                </>
            )}
            {on && <style data-proof-style>{css}</style>}
            {on && tip && <ProofBubble cell={tip.cell} x={tip.x} y={tip.y} />}
        </div>
    );
}

function ProofBubble({ cell, x, y }: { cell: ProofCell; x: number; y: number }) {
    const kind = kindOf(cell);
    // 手机窄屏：气泡贴底部、整行宽，不盖在正文上
    const narrow = typeof window !== 'undefined' && window.innerWidth < 640;
    const style = narrow
        ? { position: 'fixed' as const, left: 8, right: 8, bottom: 64 }
        : { position: 'fixed' as const, left: Math.min(x, (typeof window !== 'undefined' ? window.innerWidth : 1024) - 260), top: y + 6 };
    return (
        <div role="status" data-proof-tip style={style} className="z-50 w-64 rounded-md border bg-white p-2 text-xs shadow-lg dark:bg-neutral-900">
            <div className="font-medium">{KIND_LABEL[kind]}</div>
            <div>识别字：{cell.c ?? '—'}</div>
            <div>格位：{cell.a}</div>
            <div>方式：{cell.method || '—'}</div>
            {cell.cand && cell.cand.length > 0 && <div>候选：{cell.cand.join(' ')}</div>}
        </div>
    );
}
