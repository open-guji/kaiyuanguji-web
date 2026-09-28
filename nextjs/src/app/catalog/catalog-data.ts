/**
 * 古籍总目的服务端取数（N4b）：current/catalog/tree.json 与 current/catalog/<node>/<page>.json，
 * 带 ?v=<版本键>，与浏览器端读 current/ 的口径一致（lib/data-version.ts）。
 *
 * 与 lib/server/item-data.ts 同一套规矩：latest.json 进程内缓存 60 秒，URL 带按分钟取整的
 * 时间戳绕开 CDN 上的陈旧副本；404/403 ＝ 确定没有（返回 null），网络错与 5xx 抛错——
 * 临时故障不能被当成 404 缓存到 CDN 上。
 * N5b 合入后 item-data.ts 会有通用的 getCurrentJsonServer，届时可以换过去（本卡写域不含 lib/server）。
 */
import { dataVersionKey, type LatestPointer } from '@/lib/data-version';
import { defaultItemDataBase } from '@/lib/server/item-data';
import type { CatalogNode, CatalogWorkCard } from './catalog-route';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface CatalogFetcherOptions {
    base: string;
    fetch?: FetchLike;
    now?: () => number;
    pointerTtlMs?: number;
    timeoutMs?: number;
    /** 页面缓存条数上限（tree 另存） */
    lruSize?: number;
}

class NotFound extends Error {}

export function createCatalogFetcher(opts: CatalogFetcherOptions) {
    const base = opts.base.replace(/\/$/, '');
    const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
    const now = opts.now ?? Date.now;
    const pointerTtl = opts.pointerTtlMs ?? 60_000;
    const timeoutMs = opts.timeoutMs ?? 8_000;
    const lruSize = opts.lruSize ?? 200;
    const cache = new Map<string, Promise<unknown>>();
    let pointer: { at: number; value: Promise<LatestPointer> } | null = null;

    async function getJson<T>(url: string): Promise<T> {
        const res = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs), cache: 'force-cache' });
        if (res.status === 404 || res.status === 403) throw new NotFound(`${url} HTTP ${res.status}`);
        if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
        return (await res.json()) as T;
    }

    function getLatest(): Promise<LatestPointer> {
        const t = now();
        if (pointer && t - pointer.at < pointerTtl) return pointer.value;
        const value = getJson<LatestPointer>(`${base}/latest.json?t=${Math.floor(t / pointerTtl)}`);
        const entry = { at: t, value };
        pointer = entry;
        value.catch(() => { if (pointer === entry) pointer = null; });
        return value;
    }

    /** current/<rel>?v=<版本键>；URL 按版本键区分，内容不变，进程内缓存 */
    async function getCurrent<T>(rel: string): Promise<T | null> {
        const key = dataVersionKey(await getLatest());
        const url = `${base}/current/${rel}${key ? `?v=${key}` : ''}`;
        let p = cache.get(url) as Promise<T> | undefined;
        if (p) {
            cache.delete(url);
        } else {
            p = getJson<T>(url);
            p.catch(() => { if (cache.get(url) === p) cache.delete(url); });
        }
        cache.set(url, p);
        if (cache.size > lruSize) cache.delete(cache.keys().next().value as string);
        try {
            return await p;
        } catch (err) {
            if (err instanceof NotFound) return null;
            throw err;
        }
    }

    return {
        getTree: () => getCurrent<CatalogNode[]>('catalog/tree.json'),
        getPage: (nodeId: string, page: number) => getCurrent<CatalogWorkCard[]>(`catalog/${nodeId}/${page}.json`),
    };
}

let _default: ReturnType<typeof createCatalogFetcher> | null = null;

function defaultFetcher() {
    if (!_default) _default = createCatalogFetcher({ base: defaultItemDataBase() });
    return _default;
}

export function getCatalogTreeServer(): Promise<CatalogNode[] | null> {
    return defaultFetcher().getTree();
}

export function getCatalogPageServer(nodeId: string, page: number): Promise<CatalogWorkCard[] | null> {
    return defaultFetcher().getPage(nodeId, page);
}
