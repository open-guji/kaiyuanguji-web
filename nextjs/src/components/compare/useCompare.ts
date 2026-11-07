'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CompareItem, CompareResult, SegResult } from '@/lib/compare/compare';
import { buildDecorations, countByCat, itemByAnchor, stepItem, visibleItems, type CellDecoration } from '@/lib/compare/decorate';
import { DEFAULT_COMPARE_PREFS, loadComparePrefs, saveComparePrefs, type ComparePrefs } from '@/lib/compare/prefs';
import { runCompare } from '@/lib/compare/run';
import { formatCmp, parseCmp, type CompareTarget } from '@/lib/compare/url';
import type { BaseCell } from '@/lib/compare/volumes';
import type { CompareStatus } from './CompareSettings';

// 没有结果时用固定的空值：引用每次都变会让依赖它们的修饰表不断重算，插件又据此叫阅读器刷新，形成死循环
const NO_SEGMENTS: readonly SegResult[] = [];
const NO_ITEMS: readonly CompareItem[] = [];
const NO_DECORATIONS: ReadonlyMap<string, CellDecoration> = new Map();

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
 * 对照本状态（来自网址 ?cmp=，只认本作品别的来源，不合法静默忽略）。放在阅读页外层：来源行的「对校」按钮和阅读器里的插件共用。
 * 服务端与水合首帧一律关，保持与普通阅读页一致；挂载后读网址。
 */
export function useCompareTarget(id: string, sourceIds: readonly string[]) {
    const [target, setTargetState] = useState<CompareTarget | null>(null);
    useEffect(() => {
        const t = parseCmp(new URLSearchParams(window.location.search).get('cmp'));
        if (t && t.id !== id && sourceIds.includes(t.id)) setTargetState(t);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const setTarget = useCallback((next: CompareTarget | null) => {
        setTargetState(next);
        writeCmp(next);
    }, []);
    return { target, setTarget };
}

/**
 * 对校的比对状态：设置（存本机）、比对结果、当前焦点。取数、比对在浏览器里现场做，结果只在内存。
 * cells 是本册字格序列（阅读顺序），换册换章时换一个新数组。
 */
export function useCompare({ id, versionKey, chapter, transport, target, setTarget, cells }: {
    id: string;
    /** 底本版本 key（真实 key，非 default 占位）与本册文件 stem；还没定为 null */
    versionKey: string | null;
    chapter: string | null;
    transport: RunTransport;
    target: CompareTarget | null;
    setTarget: (t: CompareTarget | null) => void;
    cells: readonly BaseCell[] | null;
}) {
    const [prefs, setPrefsState] = useState<ComparePrefs>(DEFAULT_COMPARE_PREFS);
    const [result, setResult] = useState<(CompareResult & { cellsRef: readonly BaseCell[] }) | null>(null);
    const [status, setStatus] = useState<CompareStatus>('idle');
    const [focusId, setFocusId] = useState<string | null>(null);
    const [detailOpen, setDetailOpen] = useState(false);

    useEffect(() => {
        setPrefsState(loadComparePrefs());
    }, []);

    // 换对照本或退出：清掉焦点与结果
    useEffect(() => {
        setFocusId(null);
        setDetailOpen(false);
        if (!target) {
            setResult(null);
            setStatus('idle');
        }
    }, [target?.id]); // eslint-disable-line react-hooks/exhaustive-deps

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

    const items: readonly CompareItem[] = result?.items ?? NO_ITEMS;
    const shown = useMemo(() => visibleItems(items, prefs), [items, prefs]);
    const decorations: ReadonlyMap<string, CellDecoration> = useMemo(
        () => (result && cells === result.cellsRef ? buildDecorations(items, result.cellsRef, prefs, detailOpen ? focusId : null) : NO_DECORATIONS),
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
        status, items, shown, counts, segments: result?.segments ?? NO_SEGMENTS,
        prefs, setPrefs, decorations, current, pick, step, closeDetail: () => setDetailOpen(false),
        active: target !== null,
        target, setTarget,
    };
}
