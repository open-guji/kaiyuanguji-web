/**
 * 条目页 SSR（W2-1）的服务端取数：按 id 取一条条目 JSON。
 *
 * 只在全栈构建（KYG_RENDER_MODE=fullstack，测试站）的 /item/[id] 里用；
 * 浏览器端的取数仍走 cos-storage.ts，本模块不改它的任何行为。
 *
 * 取数顺序（31 卡 §A.6）：
 *   1. h1 哈希寻址：指针 h1/manifest-root.json → 根清单 h1/roots/<key>.json
 *      → 分片 h1/manifest/<后缀>.<hash8>.json → 条目 h1/entry/<id>.<hash8>.json
 *   2. h1 任何一步读不到（指针缺、旧格式指针没有 root、分片里没有这个 id、
 *      网络错……）→ 回退现行 latest.json → current/entry/<id>.json?v=<commit>
 *   3. 两条都确定「没有」才返回 null（页面据此出 404）；回退路径本身出网络错
 *      或 5xx 则抛错——临时故障不能被当成「条目不存在」缓存到 CDN 上。
 *
 * 缓存：除两个指针外，其余 URL 都按内容寻址、永不变，进程内 LRU 缓存即可；
 * 指针在进程内缓存 60 秒。取指针时 URL 带「按分钟取整的时间戳」查询串：
 * 2026-09-27 实测 CDN 上的 h1/manifest-root.json 已被缓存约 7 小时
 * （age 24795，还是 S3 之前的旧格式），不带查询串会一直读到旧指针。
 *
 * 草稿→正式 id 的重定向（promotions，18.9 MB）不在这里做：函数里不能整表加载。
 * W2-2 的处理见 app/item/[id]/page.ssr.tsx：查不到的草稿 id 临时跳回 /book-index，
 * 由客户端查表跳转。
 */

import { isValidItemId } from '../item-id';

export { isValidItemId };

export type ItemEntry = Record<string, unknown> & { id?: string; type?: string };

export interface ItemFetchResult {
    entry: ItemEntry;
    /** 这条是从哪条路径取到的：h1 哈希寻址，还是回退到 current/ */
    source: 'h1' | 'current';
    /**
     * 取到的是哪一版数据：`h1:<root 文件名>` 或 `current:<commitId>`。
     * 页面写进 data-ssr-version，发版后的实测据此判断 CDN 上的页面是否已换新（W2-3）。
     */
    version: string;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ItemFetcherOptions {
    /** 数据根，如 https://data.kaiyuanguji.com 或其 /staging 前缀 */
    base: string;
    fetch?: FetchLike;
    now?: () => number;
    /** 指针（manifest-root.json、latest.json）进程内缓存时长，毫秒 */
    pointerTtlMs?: number;
    /** 单次请求超时，毫秒 */
    timeoutMs?: number;
    /** 不可变对象（root、分片、entry）的进程内缓存条数上限 */
    lruSize?: number;
}

interface H1Pointer { root?: string }
interface H1RootDoc { shardKeyLength: number; shards: Record<string, string> }
interface LatestPointer { commitId?: string }


class Lru<V> {
    private map = new Map<string, V>();
    constructor(private max: number) {}
    get(k: string): V | undefined {
        const v = this.map.get(k);
        if (v !== undefined) {
            this.map.delete(k);
            this.map.set(k, v);
        }
        return v;
    }
    set(k: string, v: V): void {
        this.map.delete(k);
        this.map.set(k, v);
        if (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
    }
    delete(k: string): void {
        this.map.delete(k);
    }
}

/** 读不到（404 或数据里没有）——与网络错／5xx 区分开 */
class NotFound extends Error {}

export function createItemFetcher(opts: ItemFetcherOptions) {
    const base = opts.base.replace(/\/$/, '');
    const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
    const now = opts.now ?? Date.now;
    const pointerTtl = opts.pointerTtlMs ?? 60_000;
    const timeoutMs = opts.timeoutMs ?? 8_000;
    const immutable = new Lru<Promise<unknown>>(opts.lruSize ?? 500);
    const pointers = new Map<string, { at: number; value: Promise<unknown> }>();

    async function getJson<T>(url: string): Promise<T> {
        // force-cache：让页面保持 ISR（带 s-maxage），no-store 会把整页变成动态渲染、CDN 不缓存
        const res = await doFetch(url, { cache: 'force-cache', signal: AbortSignal.timeout(timeoutMs) });
        if (res.status === 404 || res.status === 403) throw new NotFound(`${url} HTTP ${res.status}`);
        if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
        return (await res.json()) as T;
    }

    /** 不可变对象：成功结果进 LRU；失败不留，下次重试 */
    function getImmutable<T>(url: string): Promise<T> {
        let p = immutable.get(url) as Promise<T> | undefined;
        if (!p) {
            p = getJson<T>(url);
            immutable.set(url, p);
            p.catch(() => immutable.delete(url));
        }
        return p;
    }

    /** 指针：进程内缓存 pointerTtl；URL 带按缓存周期取整的查询串，绕开 CDN 上的陈旧副本 */
    function getPointer<T>(path: string, fresh = false): Promise<T> {
        const t = now();
        const hit = pointers.get(path);
        if (!fresh && hit && t - hit.at < pointerTtl) return hit.value as Promise<T>;
        const bucket = Math.floor(t / pointerTtl);
        const value = getJson<T>(`${base}/${path}?t=${bucket}`);
        pointers.set(path, { at: t, value });
        value.catch(() => {
            if (pointers.get(path)?.value === value) pointers.delete(path);
        });
        return value;
    }

    async function resolveH1Hash(id: string, fresh: boolean): Promise<{ hash: string; root: string }> {
        const pointer = await getPointer<H1Pointer>('h1/manifest-root.json', fresh);
        // S3 之前的旧格式指针没有 root 字段——当作 h1 不可用，回退 current/
        if (!pointer.root) throw new Error('h1 指针没有 root 字段（旧格式）');
        const root = await getImmutable<H1RootDoc>(`${base}/h1/roots/${pointer.root}`);
        const shardKey = id.slice(-root.shardKeyLength);
        const shardHash = root.shards?.[shardKey];
        if (!shardHash) throw new NotFound(`h1 根清单里没有分片 ${shardKey}`);
        const shard = await getImmutable<Record<string, string>>(`${base}/h1/manifest/${shardKey}.${shardHash}.json`);
        const hash = shard[id];
        if (!hash) throw new NotFound(`h1 分片 ${shardKey} 里没有 ${id}`);
        return { hash, root: pointer.root };
    }

    async function fromH1(id: string): Promise<{ entry: ItemEntry; version: string }> {
        const first = await resolveH1Hash(id, false);
        try {
            const entry = await getImmutable<ItemEntry>(`${base}/h1/entry/${id}.${first.hash}.json`);
            return { entry, version: `h1:${first.root}` };
        } catch (err) {
            if (!(err instanceof NotFound)) throw err;
            // 指针比 COS 落后一步（发布中途）时哈希可能已失效：强制刷新指针再试一次
            const fresh = await resolveH1Hash(id, true);
            if (fresh.hash === first.hash) throw err;
            const entry = await getImmutable<ItemEntry>(`${base}/h1/entry/${id}.${fresh.hash}.json`);
            return { entry, version: `h1:${fresh.root}` };
        }
    }

    async function fromCurrent(id: string): Promise<{ entry: ItemEntry; version: string } | null> {
        const latest = await getPointer<LatestPointer>('latest.json');
        const v = latest.commitId ? `?v=${latest.commitId}` : '';
        try {
            const entry = await getImmutable<ItemEntry>(`${base}/current/entry/${id}.json${v}`);
            return { entry, version: `current:${latest.commitId ?? ''}` };
        } catch (err) {
            if (err instanceof NotFound) return null;
            throw err;
        }
    }

    /**
     * 取一条条目。确定不存在返回 null；回退路径也失败（网络错、5xx）则抛错。
     */
    async function getItem(id: string): Promise<ItemFetchResult | null> {
        if (!isValidItemId(id)) return null;
        try {
            return { ...(await fromH1(id)), source: 'h1' };
        } catch (err) {
            if (!(err instanceof NotFound)) {
                console.warn(`[item-data] h1 取 ${id} 失败，回退 current/：${(err as Error).message}`);
            }
        }
        const hit = await fromCurrent(id);
        return hit ? { ...hit, source: 'current' } : null;
    }

    return { getItem };
}

/** 服务端默认数据根：构建期注入的 NEXT_PUBLIC_COS_BASE（测试站是 …/staging），没配则用正式数据根 */
export function defaultItemDataBase(): string {
    return (process.env.NEXT_PUBLIC_COS_BASE || 'https://data.kaiyuanguji.com').replace(/\/$/, '');
}

let _default: ReturnType<typeof createItemFetcher> | null = null;

/** 进程内共享的一个取数实例（缓存跨请求复用） */
export function getItemServer(id: string): Promise<ItemFetchResult | null> {
    if (!_default) _default = createItemFetcher({ base: defaultItemDataBase() });
    return _default.getItem(id);
}
