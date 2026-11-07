'use client';

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { CellDecoration, ReaderApi, ReaderPlugin } from 'book-index-ui';
import { emptyProofLayer, isDoubtful, isHumanChecked, isMissingChar, loadProofLayer, type ProofCell, type ProofLayer } from '@/lib/proof';

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

/** 校对标注的色调：存疑＝橙色点线，缺字＝灰色虚线（颜色走阅读器 token 色，不再往页面注入 <style>） */
export function proofDecorations(cells: ProofCell[], focus: string | null): Map<string, CellDecoration> {
    const out = new Map<string, CellDecoration>();
    for (const c of cells) {
        const k = kindOf(c);
        const d: CellDecoration = k === 'missing'
            ? { tone: 'muted', underline: 'dashed', title: KIND_LABEL.missing }
            : { tone: 'warn', underline: 'dotted', title: KIND_LABEL.doubt };
        if (c.a === focus) d.focus = true;
        out.set(c.a, d);
    }
    return out;
}

/** 每章的状态：校对层（开着时才取）。onChapter 返回它，decorate／overlay 经 api.state 读 */
interface ProofChapter {
    layer: ProofLayer;
    /** 层是否已取过（开关晚于换章打开时，由浮层补取） */
    loaded: boolean;
    /** markedCells 的缓存（layer 不变就不重算） */
    cells?: ProofCell[];
}

interface ProofSnap { on: boolean | null; tip: { a: string; x: number; y: number } | null; focus: string | null }

/** 插件的小状态仓：开关（宿主的 useProofPref 同步进来）、悬停气泡、上一处／下一处的焦点格 */
export function createProofStore(set: (v: boolean) => void) {
    let snap: ProofSnap = { on: null, tip: null, focus: null };
    const subs = new Set<() => void>();
    const emit = () => subs.forEach(f => f());
    return {
        set,
        get: () => snap,
        subscribe: (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; },
        patch(p: Partial<ProofSnap>) {
            snap = { ...snap, ...p };
            emit();
        },
    };
}
export type ProofStore = ReturnType<typeof createProofStore>;

/**
 * 校对模式（D1.2，overview#605）作为阅读器插件：
 *   onChapter 取 proof_file；decorate 画存疑／缺字；onCell.hover 出气泡；overlay 放开关与「上一处／下一处」。
 * 不再碰阅读器 DOM；开关关着时 decorate 返回 undefined、不渲染任何东西，页面与未开时一致。
 */
export function proofPlugin(store: ProofStore): ReaderPlugin {
    const ID = 'kyg:proof';
    return {
        id: ID,
        async onChapter(ctx) {
            const st: ProofChapter = { layer: emptyProofLayer(), loaded: false };
            if (store.get().on === true) {
                st.layer = await loadProofLayer(ctx.entryId, { versionKey: ctx.versionKey, chapter: ctx.chapter as unknown as Record<string, unknown> }, ctx.transport as never);
                st.loaded = true;
            }
            return st;
        },
        decorate(api) {
            const { on, focus } = store.get();
            const st = api.state<ProofChapter>(ID);
            if (on !== true || !st) return undefined;
            st.cells ??= markedCells(st.layer);
            return st.cells.length ? proofDecorations(st.cells, focus) : undefined;
        },
        onCell: {
            hover(hit, api) {
                const cur = store.get();
                if (cur.on !== true) return;
                // 只对有校对记录的格出气泡
                const known = hit && hit.rect && api.state<ProofChapter>(ID)?.layer.cells.has(hit.anchor);
                if (known && hit.rect) store.patch({ tip: { a: hit.anchor, x: hit.rect.left, y: hit.rect.bottom } });
                else if (cur.tip) store.patch({ tip: null });
            },
        },
        overlay: (api) => <ProofOverlay api={api} store={store} id={ID} />,
    };
}

function ProofOverlay({ api, store, id }: { api: ReaderApi; store: ProofStore; id: string }) {
    const snap = useSyncExternalStore(store.subscribe, store.get, store.get);
    const st = api.state<ProofChapter>(id);
    const { on } = snap;
    // 开关变了、或晚于换章才打开：补取校对层，再要求重算修饰
    useEffect(() => {
        if (on === null) return;
        if (on !== true || !st || st.loaded) { api.refresh(id); return; }
        let cancelled = false;
        loadProofLayer(api.ctx.entryId, { versionKey: api.ctx.versionKey, chapter: api.ctx.chapter as unknown as Record<string, unknown> }, api.ctx.transport as never).then(layer => {
            if (cancelled) return;
            st.layer = layer; st.loaded = true; st.cells = undefined;
            api.refresh(id);
        });
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [on, st]);
    const cells = useMemo(() => (st && on ? (st.cells ??= markedCells(st.layer)) : []), [st, on, st?.layer]);
    const [cursor, setCursor] = useState(-1);
    useEffect(() => { setCursor(-1); store.patch({ focus: null, tip: null }); }, [st, store]);

    const jump = useCallback((dir: 1 | -1) => {
        if (cells.length === 0) return;
        const i = (cursor + dir + cells.length) % cells.length;
        setCursor(i);
        store.patch({ focus: cells[i].a });
        api.refresh(id);
        api.scrollTo(cells[i].a, { block: 'center' });
        const r = api.rectOf(cells[i].a);
        store.patch({ tip: r ? { a: cells[i].a, x: r.left, y: r.bottom } : null });
    }, [cells, cursor, api, id, store]);

    if (on === null) return null;
    const tipCell = snap.tip && st ? st.layer.cells.get(snap.tip.a) : undefined;
    return (
        <div data-proof-bar className="flex items-center gap-2 rounded-lg border bg-white/95 px-3 py-2 text-sm shadow dark:bg-neutral-900/95">
            <label className="flex items-center gap-1">
                <input type="checkbox" checked={on} onChange={e => store.set(e.target.checked)} />
                校对标注
            </label>
            {on && (
                <>
                    <span aria-live="polite">存疑 {cells.length} 处</span>
                    <button type="button" className="rounded border px-2" onClick={() => jump(-1)} disabled={cells.length === 0}>上一处</button>
                    <button type="button" className="rounded border px-2" onClick={() => jump(1)} disabled={cells.length === 0}>下一处</button>
                </>
            )}
            {on && snap.tip && tipCell && <ProofBubble cell={tipCell} x={snap.tip.x} y={snap.tip.y} />}
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
            {cell.cand && cell.cand.length > 0 && <div>候选：{cell.cand.map(x => (x.src?.length ? `${x.c}（${x.src.join('、')}）` : x.c)).join(' ')}</div>}
        </div>
    );
}
