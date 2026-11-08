'use client';

import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useConvert, type ReaderApi, type ReaderPlugin } from 'book-index-ui';
import { formatCmp, parseCmp, type CompareTarget } from '@/lib/compare/url';
import CompareOverlay from './CompareOverlay';
import CompareSettings, { type CompareSource } from './CompareSettings';
import { useCompare } from './useCompare';

type RunTransport = Parameters<typeof useCompare>[0]['transport'];
type CompareCtl = ReturnType<typeof useCompare>;

/**
 * 阅读页外层与阅读器插件之间的共享小仓：插件的钩子（settings／decorate／onCell）与浮层里真正持状态的控制器，
 * 都从这里读最新的对校状态。控制器每次状态变就写进来，修饰变了再叫阅读器重算（api.refresh）。
 */
export interface CompareStore {
    get(): CompareCtl | null;
    set(c: CompareCtl | null): void;
    subscribe(fn: () => void): () => void;
}

export function createCompareStore(): CompareStore {
    let cur: CompareCtl | null = null;
    const subs = new Set<() => void>();
    return {
        get: () => cur,
        set(c) {
            cur = c;
            subs.forEach((f) => f());
        },
        subscribe(fn) {
            subs.add(fn);
            return () => subs.delete(fn);
        },
    };
}

const useStoreValue = (store: CompareStore) => useSyncExternalStore(store.subscribe, store.get, () => null);

/** 浮层里常驻的控制器：持有对校状态（需要 api.cells、版本与章），把状态写进 store，渲染底部条与详情卡 */
function CompareController({ store, api, id, transport, target, setTarget }: {
    store: CompareStore;
    api: ReaderApi;
    id: string;
    transport: RunTransport;
    target: CompareTarget | null;
    setTarget: (t: CompareTarget | null) => void;
}) {
    // 同一章的 api.cells 引用稳定（包按 pages 记忆），映射后的数组跟着稳定，否则每次渲染都重算比对
    const cells = useMemo(() => (api.cells.length > 0 ? api.cells.map((c) => ({ c: c.char, a: c.anchor })) : null), [api.cells]);
    const ctl = useCompare({ id, versionKey: api.ctx.versionKey, chapter: api.ctx.chapterKey, transport, target, setTarget, cells });
    return <ControllerBody store={store} api={api} ctl={ctl} />;
}

function ControllerBody({ store, api, ctl }: { store: CompareStore; api: ReaderApi; ctl: CompareCtl }) {
    const apiRef = useRef(api);
    apiRef.current = api;
    // 状态变了写进 store；修饰表变了叫阅读器重算
    const lastDec = useRef<unknown>(null);
    useEffect(() => {
        store.set(ctl);
        if (lastDec.current !== ctl.decorations) {
            lastDec.current = ctl.decorations;
            apiRef.current.refresh('compare');
        }
    });
    useEffect(() => () => store.set(null), [store]);
    if (!ctl.active || ctl.status !== 'ready') return null;
    const go = (dir: 1 | -1) => {
        const it = ctl.step(dir);
        if (!it) return;
        const a = it.anchor.start;
        api.scrollTo(a, { block: 'center' });
        // scrollTo 把整段顶到视口上方，段落长时目标会落到屏外，书影跟视口顶格走就会差几叶；渲染后再按目标字本身居中
        const recenter = () => {
            const r = apiRef.current.rectOf(a);
            if (r) window.scrollBy({ top: r.top + r.height / 2 - window.innerHeight / 2, behavior: 'instant' as ScrollBehavior });
        };
        window.setTimeout(recenter, 120);
        window.setTimeout(recenter, 500);
    };
    return (
        <CompareOverlay
            shown={ctl.shown}
            current={ctl.current}
            counts={ctl.counts}
            onStep={go}
            onClose={ctl.closeDetail}
            onExit={() => ctl.setTarget(null)}
            convert={api.convert}
        />
    );
}

/** 组标题随繁简偏好转 */
function GroupTitle() {
    const { convert } = useConvert();
    return <>{convert('對校')}</>;
}

function SettingsBlock({ store, sources, api, id }: { store: CompareStore; sources: CompareSource[]; api: ReaderApi; id: string }) {
    const ctl = useStoreValue(store);
    return (
        <CompareSettings
            sources={sources}
            targetId={ctl?.target ? formatCmp({ id: ctl.target.id, ...(ctl.target.key && ctl.target.id === id ? { key: ctl.target.key } : {}) }) : null}
            onTarget={(v) => ctl?.setTarget(v ? parseCmp(v) : null)}
            status={ctl?.status ?? 'idle'}
            items={ctl?.items ?? []}
            segments={ctl?.segments ?? []}
            prefs={ctl?.prefs ?? { cats: { word: true, add: true, omit: true, glyph: false, struct: false }, mode: 'sub' }}
            onPrefs={(p) => ctl?.setPrefs(p)}
            convert={api.convert}
        />
    );
}

/**
 * 对校插件（A41，方案 §4.3）：设置栏「對校」选对照本与显示哪些类别，浮层出计数与上一处／下一处、点字出详情卡，
 * 按格位给字加底线、下标（对照本的写法）、字后插入（对照本多出）。只用颜色区分，不加符号。
 * target／setTarget 来自阅读页外层（来源行的「對校」按钮也用它），store 同样由外层建、与按钮共享。
 */
export function useComparePlugin({ id, sources, transport, target, setTarget, store }: {
    id: string;
    /** 作品下别的来源（不含本条目） */
    sources: CompareSource[];
    transport: RunTransport;
    target: CompareTarget | null;
    setTarget: (t: CompareTarget | null) => void;
    store: CompareStore;
}): ReaderPlugin | null {
    const hasSources = sources.length > 0;
    return useMemo<ReaderPlugin | null>(() => {
        if (!hasSources) return null;
        return {
            id: 'compare',
            settings: { group: 'compare', title: <GroupTitle />, order: 50, render: (api) => <SettingsBlock store={store} sources={sources} api={api} id={id} /> },
            overlay: (api) => <CompareController store={store} api={api} id={id} transport={transport} target={target} setTarget={setTarget} />,
            decorate: () => {
                const m = store.get()?.decorations;
                return m && m.size > 0 ? (m as ReturnType<NonNullable<ReaderPlugin['decorate']>>) : undefined;
            },
            onCell: { click: (hit) => { store.get()?.pick(hit.anchor); } },
        };
    }, [hasSources, sources, store, id, transport, target, setTarget]);
}

