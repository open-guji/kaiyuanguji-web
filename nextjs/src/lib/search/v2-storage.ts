/**
 * V2 搜索 storage 包装器
 *
 * 用 Proxy 透传底层 storage 所有方法，仅拦截 searchAll / search。
 * Worker 索引的 storeFields 已经包含渲染所需所有字段，hits 直接转 IndexEntry，
 * 不再触发 base.getAllEntries() 拉 23 MB 的 index.json。
 */

import type { IndexStorage } from 'book-index-ui/storage';
import type { IndexType, IndexEntry, PageResult, LoadOptions, GroupedSearchResult } from 'book-index-ui';
import { getSearchClient, type WorkerHit, type EntryType } from './client';

/** v2 搜索默认开启 —— index.json 已被剥离，搜索路径必须走 worker */
export function isV2SearchEnabled(): boolean {
    return true;
}

function hitToEntry(h: WorkerHit): IndexEntry {
    return {
        id: h.id,
        type: h.type as IndexType,
        title: h.title,
        isDraft: true,
        author: h.author,
        dynasty: h.dynasty,
        role: h.role,
        edition: h.edition,
        additional_titles: h.additional_titles,
        attached_texts: h.attached_texts,
        juan_count: h.juan_count,
        has_text: h.has_text,
        has_image: h.has_image,
        has_collated: h.has_collated,
        subtype: h.subtype,
        primary_name: h.primary_name,
        birth_year: h.birth_year,
        death_year: h.death_year,
        cbdb_id: h.cbdb_id,
    };
}

export function wrapWithV2Search<T extends IndexStorage>(base: T): T {
    const overrides: Partial<IndexStorage> = {
        async searchAll(query: string, limit: number = 5): Promise<GroupedSearchResult> {
            const q = query.trim();
            if (!q) {
                return {
                    works: [], books: [], collections: [], entities: [],
                    totalWorks: 0, totalBooks: 0, totalCollections: 0, totalEntities: 0,
                };
            }
            const grouped = await getSearchClient().searchAll(q, limit);
            return {
                works: grouped.works.map(hitToEntry),
                books: grouped.books.map(hitToEntry),
                collections: grouped.collections.map(hitToEntry),
                entities: grouped.entities.map(hitToEntry),
                totalWorks: grouped.totalWorks,
                totalBooks: grouped.totalBooks,
                totalCollections: grouped.totalCollections,
                totalEntities: grouped.totalEntities,
            };
        },

        async search(query: string, type: IndexType, options: LoadOptions): Promise<PageResult<IndexEntry>> {
            const q = query.trim();
            const page = options.page ?? 1;
            const pageSize = options.pageSize ?? 50;
            if (!q) return base.search(query, type, options);
            const paged = await getSearchClient().searchEntries(q, type as EntryType, page, pageSize);
            return {
                entries: paged.hits.map(hitToEntry),
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
