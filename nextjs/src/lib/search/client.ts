/**
 * 搜索 Worker 客户端 —— 在主线程包装 postMessage 调用为 Promise。
 *
 * 使用 new Worker(new URL('./worker.ts', import.meta.url))，Next.js 会自动打包为独立 chunk。
 */

export type EntryType = 'work' | 'book' | 'collection';

export interface WorkerHit {
    id: string;
    type: EntryType;
    title: string;
    author: string;
    dynasty: string;
    score: number;
}

export interface GroupedHits {
    works: WorkerHit[];
    books: WorkerHit[];
    collections: WorkerHit[];
    totalWorks: number;
    totalBooks: number;
    totalCollections: number;
}

export interface PagedHits {
    hits: WorkerHit[];
    total: number;
    page: number;
    pageSize: number;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

class SearchClient {
    private worker: Worker | null = null;
    private nextId = 1;
    private pending = new Map<number, Pending>();
    private initPromise: Promise<void> | null = null;

    private ensureWorker(): Worker {
        if (this.worker) return this.worker;
        this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
        this.worker.addEventListener('message', (ev: MessageEvent) => {
            const data = ev.data as { id: number; result?: unknown; ok?: boolean; error?: string };
            const p = this.pending.get(data.id);
            if (!p) return;
            this.pending.delete(data.id);
            if (data.error) p.reject(new Error(data.error));
            else p.resolve(data.result ?? data.ok);
        });
        this.worker.addEventListener('error', (ev) => {
            // 致命错误：拒绝所有 pending，清空
            const err = new Error(`search worker error: ${ev.message}`);
            for (const p of this.pending.values()) p.reject(err);
            this.pending.clear();
        });
        return this.worker;
    }

    private send<T>(msg: Record<string, unknown>): Promise<T> {
        const worker = this.ensureWorker();
        const id = this.nextId++;
        return new Promise<T>((resolve, reject) => {
            this.pending.set(id, {
                resolve: resolve as (v: unknown) => void,
                reject,
            });
            worker.postMessage({ ...msg, id });
        });
    }

    async init(baseUrl: string = '/data/search'): Promise<void> {
        if (this.initPromise) return this.initPromise;
        this.initPromise = this.send<boolean>({ type: 'init', baseUrl }).then(() => undefined);
        return this.initPromise;
    }

    async searchAll(query: string, limit: number = 5): Promise<GroupedHits> {
        await this.init();
        return this.send<GroupedHits>({ type: 'searchAll', query, limit });
    }

    async searchEntries(
        query: string,
        entryType: EntryType,
        page: number = 1,
        pageSize: number = 20,
    ): Promise<PagedHits> {
        await this.init();
        return this.send<PagedHits>({ type: 'searchEntries', query, entryType, page, pageSize });
    }
}

let singleton: SearchClient | null = null;

export function getSearchClient(): SearchClient {
    if (!singleton) singleton = new SearchClient();
    return singleton;
}
