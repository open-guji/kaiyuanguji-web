'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CompareItem, CompareResult } from '@/lib/compare/compare';
import { buildDecorations, countByCat, itemByAnchor, stepItem, visibleItems, type CellDecoration } from '@/lib/compare/decorate';
import { DEFAULT_COMPARE_PREFS, loadComparePrefs, saveComparePrefs, type ComparePrefs } from '@/lib/compare/prefs';
import { runCompare } from '@/lib/compare/run';
import { formatCmp, parseCmp, type CompareTarget } from '@/lib/compare/url';
import type { BaseCell } from '@/lib/compare/volumes';
import type { CompareStatus } from './CompareSettings';

type RunTransport = Parameters<typeof runCompare>[0]['transport'];

/** 把 ?cmp= 写回地址栏（replaceState，不留历史），保留其余查询参数与 #；target 为 null 则删掉该参数 */
export function writeCmp(target: CompareTarget | null): void {
    const url = new URL(window.location.href);
    if (target) url.searchParams.set('cmp', formatCmp(target));
    else url.searchParams.delete('cmp');
    const next = url.pathname + url.search + url.hash;
    if (next !== window.location.pathname + window.location.search + window.location.hash) window.history.replaceState(window.history.state, '', next);
}

/**
 * 对校的状态：对照本（来自网址 ?cmp=，只认本作品下别的来源，不合法静默忽略）、设置（存本机）、比对结果、当前焦点。
 * 取数、比对在浏览器里现场做，结果只在内存。cells 是本册字格序列（阅读顺序），换册换章时换一个新数组。
 */
export function useCompare({ id, versionKey, chapter, transport, sourceIds, cells }: {
    id: string;
    /** 底本版本 key（真实 key，非 default 占位）与本册文件 stem；还没定为 null */
    versionKey: string | null;
    chapter: string | null;
    transport: RunTransport;
    /** 作品下别的来源条目 id（不含本条目） */
    sourceIds: readonly string[];
    cells: readonly BaseCell[] | null;
}) {
    const [target, setTargetState] = useState<CompareTarget | null>(null);
    const [prefs, setPrefsState] = useState<ComparePrefs>(DEFAULT_COMPARE_PREFS);
    const [result, setResult] = useState<(CompareResult & { cellsRef: readonly BaseCell[] }) | null>(null);
    const [status, setStatus] = useState<CompareStatus>('idle');
    const [focusId, setFocusId] = useState<string | null>(null);
    const [detailOpen, setDetailOpen] = useState(false);

    // 挂载后读网址与本机设置（服务端与水合首帧一律关，保持与普通阅读页一致）
    useEffect(() => {
        const t = parseCmp(new URLSearchParams(window.location.search).get('cmp'));
        if (t && sourceIds.includes(t.id) && t.id !== id) setTargetState(t);
        setPrefsState(loadComparePrefs());
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const setTarget = useCallback((next: CompareTarget | null) => {
        setTargetState(next);
        setFocusId(null);
        setDetailOpen(false);
        if (!next) setResult(null);
        writeCmp(next);
    }, []);
    const setPrefs = useCallback((p: ComparePrefs) => {
        setPrefsState(p);
        saveComparePrefs(p);
    }, []);

    // 比对：对照本、册、字序列任一变了重算；过期的结果丢弃
    const seq = useRef(0);
    useEffect(() => {
        if (!target || !versionKey || !chapter || !cells || cells.length === 0) return;
        const mine = ++seq.current;
        setStatus('loading');
        setResult(null);
        runCompare({ transport, base: { id, key: versionKey, chapter }, target, cells })
            .then((r) => {
                if (seq.current !== mine) return;
                setResult({ items: r.items, segments: r.segments, cellsRef: cells });
                setStatus('ready');
                // 地址里的版本 key 补成真实 key（?cmp=<id> → ?cmp=<id>-<key>）
                if (!target.key) writeCmp({ id: target.id, key: r.targetKey });
            })
            .catch(() => {
                if (seq.current !== mine) return;
                setStatus('error');
            });
        return () => {
            seq.current++;
        };
    }, [target, id, versionKey, chapter, cells, transport]);

    const items: readonly CompareItem[] = result?.items ?? [];
    const shown = useMemo(() => visibleItems(items, prefs), [items, prefs]);
    const decorations: ReadonlyMap<string, CellDecoration> = useMemo(
        () => (result && cells === result.cellsRef ? buildDecorations(items, result.cellsRef, prefs, detailOpen ? focusId : null) : new Map()),
        [items, result, cells, prefs, focusId, detailOpen],
    );
    const byAnchor = useMemo(() => (result ? itemByAnchor(items, result.cellsRef) : new Map<string, CompareItem>()), [items, result]);
    const counts = useMemo(() => {
        const n = countByCat(shown);
        return (Object.keys(n) as (keyof typeof n)[]).filter((c) => prefs.cats[c]).map((cat) => ({ cat, n: n[cat] }));
    }, [shown, prefs]);
    const current = useMemo(() => (detailOpen ? items.find((i) => i.id === focusId) ?? null : null), [items, focusId, detailOpen]);

    const focus = useCallback((item: CompareItem | null) => {
        setFocusId(item?.id ?? null);
        setDetailOpen(item !== null);
    }, []);
    /** 点了某个字：若它落在显示中的差异里，打开详情；返回是否命中（宿主据此决定要不要滚动） */
    const pick = useCallback((anchor: string) => {
        const it = byAnchor.get(anchor);
        if (!it || !prefs.cats[it.cat]) return null;
        focus(it);
        return it;
    }, [byAnchor, prefs, focus]);
    const step = useCallback((dir: 1 | -1) => {
        const it = stepItem(shown, focusId, dir);
        focus(it);
        return it;
    }, [shown, focusId, focus]);

    return {
        target, setTarget, status, items, shown, counts, segments: result?.segments ?? [],
        prefs, setPrefs, decorations, current, pick, step, closeDetail: () => setDetailOpen(false),
        active: target !== null,
    };
}
