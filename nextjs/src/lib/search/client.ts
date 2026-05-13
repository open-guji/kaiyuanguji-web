/**
 * 搜索 Worker 客户端 —— 在主线程包装 postMessage 调用为 Promise。
 *
 * 使用 new Worker(new URL('./worker.ts', import.meta.url))，Next.js 会自动打包为独立 chunk。
 */

import { getCosSearchBaseUrl } from '../cos-storage';

export type EntryType = 'work' | 'book' | 'collection' | 'entity';

/**
 * 默认的搜索分片根 URL：根据构建时 env 决定。
 * - cos 模式下返回 Promise<...>（含 latest.json 版本号）
 * - 其他模式同站 /data/search
 *
 * 注意：searchAll / searchEntries 内部 `await this.init()` 若不传 baseUrl，
 * 会落回这个默认值。所以即使调用方忘记显式 init(getSearchBaseUrl(source))，
 * 也能在 cos 模式下走到 COS。
 */
function defaultSearchBaseUrl(): string | Promise<string> {
    if (process.env.NEXT_PUBLIC_DATA_SOURCE === 'cos') {
        return getCosSearchBaseUrl();
    }
    return '/data/search';
}

export interface WorkerHit {
    id: string;
    type: EntryType;
    title: string;
    author?: string;
    dynasty?: string;
    role?: string;
    edition?: string;
    additional_titles?: string[];
    attached_texts?: string[];
    juan_count?: number;
    has_text?: boolean;
    has_image?: boolean;
    has_collated?: boolean;
    subtype?: string;
    primary_name?: string;
    birth_year?: number;
    death_year?: number;
    cbdb_id?: number;
    score: number;
}

export interface GroupedHits {
    works: WorkerHit[];
    books: WorkerHit[];
    collections: WorkerHit[];
    entities: WorkerHit[];
    totalWorks: number;
    totalBooks: number;
    totalCollections: number;
    totalEntities: number;
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

    async init(baseUrl?: string | Promise<string>): Promise<void> {
        // 允许 Promise<string>：COS 模式下 baseUrl 取决于 latest.json，是异步的。
        // 并发调用安全：立即占位 initPromise，避免两个调用者各 send 一次 init。
        if (this.initPromise) return this.initPromise;
        const url = baseUrl ?? defaultSearchBaseUrl();
        this.initPromise = (async () => {
            const resolved = typeof url === 'string' ? url : await url;
            await this.send<boolean>({ type: 'init', baseUrl: resolved });
        })();
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
