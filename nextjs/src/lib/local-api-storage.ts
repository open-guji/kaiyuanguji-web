/**
 * Client-side storage adapter for local dev API routes.
 *
 * Calls /api/book-index/* endpoints served by Next.js dev server,
 * which read data from the local book-index-draft repository.
 */

import type { IndexStorage } from 'book-index-ui/storage';
import type { IndexType, IndexEntry, PageResult, LoadOptions, GroupedSearchResult, VolumeBookMapping, ResourceCatalog, CollatedEditionIndex, CollatedJuan, ResourceProgress } from 'book-index-ui';
import { normalizeCatalog } from 'book-index-ui';

export class LocalApiStorage implements IndexStorage {
    private base: string;

    constructor(base: string = '/api/book-index') {
        this.base = base;
    }

    async getEntry(id: string): Promise<IndexEntry | null> {
        const res = await fetch(`${this.base}/entry/${encodeURIComponent(id)}`);
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    }

    async getAllEntries(): Promise<IndexEntry[]> {
        const types = ['book', 'work', 'collection', 'entity'];
        const results = await Promise.all(
            types.map(t => fetch(`${this.base}/all-entries?type=${t}`).then(r => r.json())),
        );
        return results.flat();
    }

    async loadEntries(type: IndexType, options: LoadOptions): Promise<PageResult<IndexEntry>> {
        const params = new URLSearchParams({
            type,
            page: String(options.page ?? 1),
            pageSize: String(options.pageSize ?? 50),
            sortBy: options.sortBy ?? 'title',
            sortOrder: options.sortOrder ?? 'asc',
        });
        const res = await fetch(`${this.base}/entries?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    }

    async search(query: string, type: IndexType, options: LoadOptions): Promise<PageResult<IndexEntry>> {
        const params = new URLSearchParams({
            q: query,
            type,
            page: String(options.page ?? 1),
            pageSize: String(options.pageSize ?? 50),
        });
        const res = await fetch(`${this.base}/search?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    }

    async searchAll(query: string, limit: number = 5): Promise<GroupedSearchResult> {
        const params = new URLSearchParams({ q: query, limit: String(limit) });
        const res = await fetch(`${this.base}/search-all?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    }

    async getItem(id: string): Promise<Record<string, unknown> | null> {
        const res = await fetch(`${this.base}/item/${encodeURIComponent(id)}`);
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    }

    async getCollectionCatalogs(collectionId: string): Promise<ResourceCatalog[] | null> {
        const res = await fetch(`${this.base}/catalog/${encodeURIComponent(collectionId)}`);
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const catalogs: ResourceCatalog[] = await res.json();
        return catalogs.map(c => ({ ...c, data: normalizeCatalog(c.data) }));
    }

    async getCollectionCatalog(collectionId: string): Promise<VolumeBookMapping | null> {
        const catalogs = await this.getCollectionCatalogs(collectionId);
        return catalogs?.[0]?.data ?? null;
    }

    async getCollatedEditionIndex(workId: string): Promise<CollatedEditionIndex | null> {
        const res = await fetch(`${this.base}/collated/${encodeURIComponent(workId)}`);
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    }

    async getCollatedJuan(workId: string, juanFile: string): Promise<CollatedJuan | null> {
        const res = await fetch(`${this.base}/collated/${encodeURIComponent(workId)}/${encodeURIComponent(juanFile)}`);
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    }

    async getResourceProgress(): Promise<ResourceProgress | null> {
        const res = await fetch(`${this.base}/resource-progress`);
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    }

    async getSiteProgress(): Promise<ResourceProgress | null> {
        const res = await fetch(`${this.base}/resource-site-progress`);
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
    }

    async getResourceCounts(): Promise<{ hasText: number; hasImage: number }> {
        const res = await fetch(`${this.base}/resource-counts`);
        if (!res.ok) return { hasText: 0, hasImage: 0 };
        return res.json();
    }

    // Write operations not supported in local read mode
    async saveItem(): Promise<{ id: string; path: string }> {
        throw new Error('LocalApiStorage: read-only mode');
    }

    async deleteItem(): Promise<void> {
        throw new Error('LocalApiStorage: read-only mode');
    }

    async generateId(): Promise<string> {
        throw new Error('LocalApiStorage: read-only mode');
    }
}
