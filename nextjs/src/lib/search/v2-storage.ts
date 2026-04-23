/**
 * V2 搜索 storage 包装器
 *
 * 用 Proxy 透传底层 storage 所有方法，仅拦截 searchAll / search。
 * 结果通过 base.getAllEntries() 建 id→entry map hydration，保证完全兼容
 * GroupedSearchResult 形状，调用方无需改动。
 */

import type { IndexStorage } from 'book-index-ui/storage';
import type { IndexType, IndexEntry, PageResult, LoadOptions, GroupedSearchResult } from 'book-index-ui';
import { getSearchClient, type WorkerHit, type EntryType } from './client';

export function isV2SearchEnabled(): boolean {
    if (typeof process !== 'undefined' && process.env && process.env.NEXT_PUBLIC_SEARCH_V2 === '1') {
        return true;
    }
    return false;
}

/** 构建 base 的全量 id→entry map（仅首次调用时加载，之后复用） */
function makeEntryMapCache(base: IndexStorage) {
    let p: Promise<Map<string, IndexEntry>> | null = null;
    return () => {
        if (p) return p;
        p = (async () => {
            const all = await base.getAllEntries!();
            const map = new Map<string, IndexEntry>();
            for (const e of all) map.set(`${e.type}:${e.id}`, e);
            return map;
        })();
        return p;
    };
}

function hydrate(hits: WorkerHit[], map: Map<string, IndexEntry>): IndexEntry[] {
    const out: IndexEntry[] = [];
    for (const h of hits) {
        const full = map.get(`${h.type}:${h.id}`);
        if (full) out.push(full);
        else out.push({ id: h.id, type: h.type as IndexType, title: h.title, author: h.author, dynasty: h.dynasty });
    }
    return out;
}

export function wrapWithV2Search<T extends IndexStorage>(base: T): T {
    const getMap = makeEntryMapCache(base);

    const overrides: Partial<IndexStorage> = {
        async searchAll(query: string, limit: number = 5): Promise<GroupedSearchResult> {
            const q = query.trim();
            if (!q) {
                return { works: [], books: [], collections: [], totalWorks: 0, totalBooks: 0, totalCollections: 0 };
            }
            const client = getSearchClient();
            const [grouped, map] = await Promise.all([client.searchAll(q, limit), getMap()]);
            return {
                works: hydrate(grouped.works, map),
                books: hydrate(grouped.books, map),
                collections: hydrate(grouped.collections, map),
                totalWorks: grouped.totalWorks,
                totalBooks: grouped.totalBooks,
                totalCollections: grouped.totalCollections,
            };
        },

        async search(query: string, type: IndexType, options: LoadOptions): Promise<PageResult<IndexEntry>> {
            const q = query.trim();
            const page = options.page ?? 1;
            const pageSize = options.pageSize ?? 50;
            if (!q) return base.search(query, type, options);
            const client = getSearchClient();
            const [paged, map] = await Promise.all([
                client.searchEntries(q, type as EntryType, page, pageSize),
                getMap(),
            ]);
            return {
                entries: hydrate(paged.hits, map),
                total: paged.total,
                page: paged.page,
                pageSize: paged.pageSize,
            };
        },
    };

    return new Proxy(base, {
        get(target, prop, receiver) {
            if (prop in overrides) {
                const fn = (overrides as Record<string | symbol, unknown>)[prop];
                return typeof fn === 'function' ? fn.bind(overrides) : fn;
            }
            const value = Reflect.get(target, prop, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    }) as T;
}
