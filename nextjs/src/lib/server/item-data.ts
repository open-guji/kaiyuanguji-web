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
 *      网络错……）→ 回退现行 latest.json → current/entry/<id>.json?v=<cacheKey|commit>
 *   3. 两条都确定「没有」才返回 null（页面据此出 404）；回退路径本身出网络错
 *      或 5xx 则抛错——临时故障不能被当成「条目不存在」缓存到 CDN 上。
 *
 * 缓存：除两个指针外，其余 URL 都按内容寻址、永不变，进程内 LRU 缓存即可；
 * 指针在进程内缓存 60 秒。取指针时 URL 带「按分钟取整的时间戳」查询串：
 * 2026-09-27 实测 CDN 上的 h1/manifest-root.json 已被缓存约 7 小时
 * （age 24795，还是 S3 之前的旧格式），不带查询串会一直读到旧指针。
 *
 * 草稿→正式 id（PH）：整张 promotions.json 曾有 18.9 MB，函数里不能整表加载；
 * 打包时按与 manifest 同一套后缀分片进 h1（root 的 promotionShards → 分片
 * h1/promotions/<后缀>.<hash8>.json，内容 { 草稿id: 正式id }），这里一次只取一片。
 * 见 resolvePromotion；页面据此 308（app/item/[id]/page.ssr.tsx）。
 */

import { isValidItemId } from '../item-id';
import { dataVersionKey, type LatestPointer } from '../data-version';
import { PROMOTION_SHARD_KEY_LENGTH } from '../promotions';

export { isValidItemId };

export type ItemEntry = Record<string, unknown> & { id?: string; type?: string };

export interface ItemFetchResult {
    entry: ItemEntry;
    /** 这条是从哪条路径取到的：h1 哈希寻址，还是回退到 current/ */
    source: 'h1' | 'current';
    /**
     * 取到的是哪一版数据：`h1:<root 文件名>` 或 `current:<版本键>`（cacheKey，旧数据回退 commitId）。
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
    /**
     * 网络错或 5xx 时原地再试几次（默认 1 次，间隔 retryDelayMs）。overview#322：冷渲染时取数一出临时故障，
     * ISR 页面整页只回 21 字节的纯文本「Internal Server Error」，读者要自己刷新；在服务端多试一次就过去了。
     * 超时（AbortError／TimeoutError）不重试：已经等了 timeoutMs，再等会超过 EdgeOne 回源时限。
     * 中间件传 0：边缘上不多发子请求，取不到就放行交给页面。
     */
    retries?: number;
    retryDelayMs?: number;
    /**
     * 请求是否带 cache: 'force-cache'（默认 true，页面据此保持 ISR）。
     * 中间件（边缘运行时）传 false：那里不认这个选项，可能直接抛错。
     */
    forceCache?: boolean;
}

interface H1Pointer { root?: string }
interface H1RootDoc {
    shardKeyLength: number;
    shards: Record<string, string>;
    /** PH 之后的 root 才有；没有这个字段＝这一版不知道升格情况 */
    promotionShards?: Record<string, string>;
}

/**
 * 草稿 id 查升格对照表的结果：
 *   promoted — 升格成了 to
 *   absent   — 这一版的对照表确定没有它
 *   unknown  — 查不了（h1 不可用、旧 root 没有对照表、网络错……），调用方按老办法处理
 */
export type PromotionLookup =
    | { status: 'promoted'; to: string }
    | { status: 'absent' }
    | { status: 'unknown' };


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

/**
 * 单次请求的超时信号。EdgeOne 边缘运行时（中间件跑在那里）没有 AbortSignal.timeout，
 * 直接调会抛 TypeError，中间件的 /item 跳转因此从没生效过（FX1c）；缺时退回 AbortController＋setTimeout。
 * 返回的 clear 由调用方在读完响应体后调用：兜底分支的定时器不清会每次取数都留一个，拖住边缘 isolate。
 */
function timeoutSignal(ms: number): { signal: AbortSignal; clear: () => void } {
    if (typeof AbortSignal.timeout === 'function') return { signal: AbortSignal.timeout(ms), clear: () => {} };
    const c = new AbortController();
    const timer = setTimeout(() => c.abort(new DOMException(`timeout ${ms}ms`, 'TimeoutError')), ms);
    return { signal: c.signal, clear: () => clearTimeout(timer) };
}

/** 读不到（404 或数据里没有）——与网络错／5xx 区分开 */
class NotFound extends Error {}

/**
 * 本地联调：设了 KYG_LOCAL_PUBLIC_DATA=1 时，条目与阅读文本先读本机 `nextjs/public/data/<相对路径>`，
 * 读不到再走线上。给本地跑还没上线的新结构文本用，正式构建不设这个变量。
 *
 * 读文件的实现在 `local-public-data.ts`（只由 Node 端页面引入、按变量注册到 globalThis）。本文件也被
 * 中间件（Edge 运行时）引用，不能在这里用 fs／eval，否则 next build 报 Dynamic Code Evaluation。
 */
function readLocalPublicData(relPath: string): string | null {
    const read = (globalThis as { __kygLocalPublicRead?: (p: string) => string | null }).__kygLocalPublicRead;
    return read ? read(relPath) : null;
}

/** getItem 的取法选项，见 createItemFetcher 里 getItem 的注释 */
export interface ItemGetOptions {
    prefer?: 'h1' | 'current';
    currentOnly?: boolean;
}

export function createItemFetcher(opts: ItemFetcherOptions) {
    const base = opts.base.replace(/\/$/, '');
    const doFetch: FetchLike = opts.fetch ?? ((url, init) => fetch(url, init));
    const now = opts.now ?? Date.now;
    const pointerTtl = opts.pointerTtlMs ?? 60_000;
    const timeoutMs = opts.timeoutMs ?? 8_000;
    const forceCache = opts.forceCache ?? true;
    const retries = opts.retries ?? 1;
    const retryDelayMs = opts.retryDelayMs ?? 250;
    const immutable = new Lru<Promise<unknown>>(opts.lruSize ?? 500);
    const pointers = new Map<string, { at: number; value: Promise<unknown> }>();

    /**
     * 发一次请求并读完响应体（read 在超时信号的保护下）；网络错与 5xx 按 retries 原地重试，404/403 与超时不重试。
     */
    async function fetchRead<R>(url: string, read: (res: Response) => Promise<R>): Promise<R> {
        for (let attempt = 0; ; attempt++) {
            // force-cache：让页面保持 ISR（带 s-maxage），no-store 会把整页变成动态渲染、CDN 不缓存
            const timeout = timeoutSignal(timeoutMs);
            try {
                const init: RequestInit = { signal: timeout.signal };
                if (forceCache) init.cache = 'force-cache';
                const res = await doFetch(url, init);
                if (res.status >= 500 && attempt < retries) {
                    console.warn(`[item-data] ${url} HTTP ${res.status}，${retryDelayMs}ms 后重试`);
                } else {
                    return await read(res);
                }
            } catch (err) {
                const name = (err as Error)?.name;
                if (err instanceof NotFound || name === 'AbortError' || name === 'TimeoutError' || attempt >= retries) throw err;
                console.warn(`[item-data] ${url} 失败（${(err as Error).message}），${retryDelayMs}ms 后重试`);
            } finally {
                timeout.clear();
            }
            await new Promise((r) => setTimeout(r, retryDelayMs));
        }
    }

    function getJson<T>(url: string): Promise<T> {
        return fetchRead(url, async (res) => {
            if (res.status === 404 || res.status === 403) throw new NotFound(`${url} HTTP ${res.status}`);
            if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
            return (await res.json()) as T;
        });
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
        // 版本键优先 cacheKey（三仓合成），旧 latest.json 没有时回退 commitId（overview#169）
        const key = dataVersionKey(latest);
        const v = key ? `?v=${key}` : '';
        try {
            const entry = await getImmutable<ItemEntry>(`${base}/current/entry/${id}.json${v}`);
            return { entry, version: `current:${key ?? ''}` };
        } catch (err) {
            if (err instanceof NotFound) return null;
            throw err;
        }
    }

    /**
     * 查升格对照表的首选路径（overview#491）：latest.json 指针 → current/promotions/<后缀>.json?v=<版本键>（web#318 起数据包里有）。
     * 指针与条目查询共用同一次 getPointer，所以与条目并行时只多 1 个小文件（每片几 KB），深度 2；h1 那条是指针 → root → 分片，深度 3。
     * 返回 null＝这条路径答不了（旧数据包没有该目录、分片坏了或为空），调用方改走 h1；抛错（网络、5xx）同样由调用方改走 h1。
     * 合法分片里没有这个 id 就是确定没有升格（absent），与 h1 分片同一语义。
     */
    async function resolvePromotionCurrent(id: string): Promise<PromotionLookup | null> {
        const latest = await getPointer<LatestPointer>('latest.json');
        const key = dataVersionKey(latest);
        const v = key ? `?v=${key}` : '';
        let shard: { version?: unknown; promotions?: unknown };
        try {
            shard = await getImmutable(`${base}/current/promotions/${id.slice(-PROMOTION_SHARD_KEY_LENGTH)}.json${v}`);
        } catch (err) {
            if (err instanceof NotFound) return null;
            throw err;
        }
        const rows = shard?.promotions;
        // 打包只产出非空的合法片：版本不对、形状坏、空表都当「这条路径答不了」
        if (shard?.version !== 1 || !rows || typeof rows !== 'object' || Array.isArray(rows) || Object.keys(rows).length === 0) return null;
        const row = (rows as Record<string, unknown>)[id];
        if (row === undefined) return { status: 'absent' };
        const to = row && typeof row === 'object' ? (row as { production_id?: unknown }).production_id : undefined;
        if (typeof to !== 'string') return null;   // 这个 id 的记录本身坏了：让 h1 来判，不当成「没升格」
        return to !== id && isValidItemId(to) ? { status: 'promoted', to } : { status: 'absent' };
    }

    /** 查升格对照表：先 current/promotions 分片，答不了再走 h1（指针 → root.promotionShards → 分片）。只读当前指针指向的那一版 */
    async function resolvePromotion(id: string): Promise<PromotionLookup> {
        if (!isValidItemId(id)) return { status: 'absent' };
        if (id.length >= PROMOTION_SHARD_KEY_LENGTH) {
            try {
                const cur = await resolvePromotionCurrent(id);
                if (cur) return cur;
            } catch (err) {
                console.warn(`[item-data] current/promotions 查 ${id} 失败，改走 h1：${(err as Error).message}`);
            }
        }
        try {
            const pointer = await getPointer<H1Pointer>('h1/manifest-root.json');
            if (!pointer.root) return { status: 'unknown' };
            const root = await getImmutable<H1RootDoc>(`${base}/h1/roots/${pointer.root}`);
            const shards = root.promotionShards;
            if (!shards || typeof shards !== 'object') return { status: 'unknown' };
            const shardKey = id.slice(-root.shardKeyLength);
            const shardHash = shards[shardKey];
            if (!shardHash) return { status: 'absent' };
            const shard = await getImmutable<Record<string, string>>(`${base}/h1/promotions/${shardKey}.${shardHash}.json`);
            const to = shard[id];
            if (typeof to === 'string' && to !== id && isValidItemId(to)) return { status: 'promoted', to };
            return { status: 'absent' };
        } catch (err) {
            console.warn(`[item-data] 查 ${id} 的升格对照表失败：${(err as Error).message}`);
            return { status: 'unknown' };
        }
    }

    /**
     * 先走 current/ 的取法（overview#322 B1）：latest.json 指针 → current/entry/<id>.json，冷实例上 2 跳，
     * 指针还与 manifest 链共用（阅读页的 checkReader、中间件的旧地址换算都读它），多数时候只多 1 跳。
     * current/ 确定没有时再问一次 h1（两边由同一次打包发出，不该不一致；h1 也查不了就按没有算）；
     * current/ 出网络错或 5xx 时回到 h1 优先的完整取法。
     */
    async function getItemCurrentFirst(id: string, currentOnly = false): Promise<ItemFetchResult | null> {
        try {
            const hit = await fromCurrent(id);
            if (hit) return { ...hit, source: 'current' };
        } catch (err) {
            // currentOnly：调用方只要 current/ 的肯定答案（中间件），出错就抛，不再串 h1 的 4 跳
            if (currentOnly) throw err;
            console.warn(`[item-data] current/ 取 ${id} 失败，改走 h1：${(err as Error).message}`);
            return getItem(id);
        }
        if (currentOnly) return null;
        try {
            return { ...(await fromH1(id)), source: 'h1' };
        } catch {
            return null;
        }
    }

    /**
     * 取一条条目。确定不存在返回 null；回退路径也失败（网络错、5xx）则抛错。
     *
     * prefer: 'current' —— 只要条目内容（书名、被并、升格）、不在乎 data-ssr-version 是哪条路径的调用方用：
     * 阅读页与中间件（overview#322 B1：h1 是 4 跳串行，冷实例与冷边缘实例上首个请求要等它走完）。
     * 条目页 /item/<id> 仍走 h1 优先：发版后的 item-cache-verify 按 data-ssr-version=h1:<新 root> 判断缓存已换新。
     *
     * currentOnly（配合 prefer: 'current'）—— current/ 没有就是没有，不再问 h1；current/ 出错直接抛。
     * 给只凭「肯定的答案」才行动的调用方用（中间件：被并目标、升格都是正向证据，查不出就放过交给页面）。
     * 冷边缘上每多一跳都吃 2 秒预算，promoted 草稿 id 在 current/ 与 h1 的条目里本来就都没有，
     * 原先白走 h1 的 manifest-root → roots → manifest 分片 3 跳才得出「没有」（overview#491）。
     */
    async function getItem(id: string, opts?: ItemGetOptions): Promise<ItemFetchResult | null> {
        if (!isValidItemId(id)) return null;
        if (opts?.prefer === 'current') return getItemCurrentFirst(id, opts.currentOnly === true);
        try {
            return { ...(await fromH1(id)), source: 'h1' };
        } catch (err) {
            if (!(err instanceof NotFound)) {
                console.warn(`[item-data] h1 取 ${id} 失败，回退 current/：${(err as Error).message}`);
            }
        }
        const hit = await fromCurrent(id);
        if (hit) return { ...hit, source: 'current' };
        const local = readLocalPublicData(`entry/${id}.json`);
        if (local !== null) return { entry: JSON.parse(local), source: 'current', version: 'local' };
        return null;
    }

    /**
     * 取 current/ 下的一个数据文件（N5b：阅读页服务端校验卷号用，如 items/<id>/manifest.json）。
     * 与浏览器端 BundleStorage 同一个地址（带 ?v=<版本键>）。确定没有返回 null；网络错、5xx 抛错。
     */
    async function getCurrentJson<T>(relPath: string): Promise<T | null> {
        // 本地联调：public/data/ 里有就直接用（KYG_LOCAL_PUBLIC_DATA=1）
        const localJson = readLocalPublicData(relPath);
        if (localJson !== null) return JSON.parse(localJson) as T;

        const latest = await getPointer<LatestPointer>('latest.json');
        const key = dataVersionKey(latest);
        try {
            return await getImmutable<T>(`${base}/current/${relPath}${key ? `?v=${key}` : ''}`);
        } catch (err) {
            if (err instanceof NotFound) return null;
            throw err;
        }
    }

    /**
     * 取 current/ 下的一个文本文件（WEB2：阅读页把首卷正文随页面交给浏览器）。
     * 地址同 getCurrentJson。不进 LRU（正文可能上百 KB）；超过 maxBytes 当作不取，返回 null。
     * 确定没有返回 null；网络错、5xx 抛错。
     */
    async function getCurrentText(relPath: string, maxBytes = Infinity): Promise<string | null> {
        const localText = readLocalPublicData(relPath);
        if (localText !== null) return localText.length > maxBytes ? null : localText;

        const latest = await getPointer<LatestPointer>('latest.json');
        const key = dataVersionKey(latest);
        const url = `${base}/current/${relPath}${key ? `?v=${key}` : ''}`;
        return fetchRead(url, async (res) => {
            if (res.status === 404 || res.status === 403) return null;
            if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
            const text = await res.text();
            return text.length > maxBytes ? null : text;
        });
    }

    return { getItem, resolvePromotion, getCurrentJson, getCurrentText };
}

/** 服务端默认数据根：构建期注入的 NEXT_PUBLIC_COS_BASE（测试站是 …/staging），没配则用正式数据根 */
export function defaultItemDataBase(): string {
    return (process.env.NEXT_PUBLIC_COS_BASE || 'https://data.kaiyuanguji.com').replace(/\/$/, '');
}

let _default: ReturnType<typeof createItemFetcher> | null = null;

function defaultFetcher(): ReturnType<typeof createItemFetcher> {
    if (!_default) _default = createItemFetcher({ base: defaultItemDataBase() });
    return _default;
}

/** 进程内共享的一个取数实例（缓存跨请求复用） */
export function getItemServer(id: string, opts?: ItemGetOptions): Promise<ItemFetchResult | null> {
    return defaultFetcher().getItem(id, opts);
}

/** current/ 下的数据文件（同一个取数实例，latest.json 指针缓存共用） */
export function getCurrentJsonServer<T>(relPath: string): Promise<T | null> {
    return defaultFetcher().getCurrentJson<T>(relPath);
}

/** current/ 下的文本文件（同一个取数实例） */
export function getCurrentTextServer(relPath: string, maxBytes?: number): Promise<string | null> {
    return defaultFetcher().getCurrentText(relPath, maxBytes);
}

/** 草稿 id 查升格对照表（同一个取数实例，指针与 root 缓存共用） */
export function getPromotionServer(id: string): Promise<PromotionLookup> {
    return defaultFetcher().resolvePromotion(id);
}
