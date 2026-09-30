/**
 * Meilisearch storage 包装器（L1 层）
 *
 * Hybrid 架构：
 *   L1: 上海云 Meilisearch（全文 + 拼音 + 异体 + completeness 排序）
 *   L2: 现有 worker 索引（v2-storage 包装的 base）— 任何 L1 错误时透传到 L2
 *
 * 两种 L1 接法（S1，2026-09-28）：
 *   - 代理（默认）：同站 /api/search（edge-functions/api/search.js）。浏览器看不到
 *     Meili 地址与 key；四类索引一次请求。代理失败（503／超时）→ 当次就走 L2
 *     （L2 已缩成只含书名＋作者的轻量分片），并通知页面显示「简易搜索」提示。
 *   - 直连（回退开关 NEXT_PUBLIC_SEARCH_DIRECT_URL／_KEY，保留一个版本）：浏览器直连 Meili，
 *     行为与改造前一致。
 *
 * 客户端只在 searchAll / search 上做 L1，其他方法（getEntry / getCounts /
 * getCollatedJuan 等）暂保持透传到 L2。Phase 4 再把详情类也加 L1。
 *
 * Circuit breaker：连续 N 次失败后短暂不再访问 L1，直接走 L2，避免
 * 每次搜索都等 2 秒超时。
 */

import type { IndexStorage } from 'book-index-ui/storage';
import type { IndexEntry, IndexType, PageResult, LoadOptions, GroupedSearchResult } from 'book-index-ui';
import { SNIPPET_MARK_START, SNIPPET_MARK_END, buildMeiliFilter, hasActiveFilters } from 'book-index-ui';
import type { SearchFilters } from 'book-index-ui';

export interface MeiliConfig {
    /** 代理地址（同站 '/api/search'）。给了就走代理，忽略 baseUrl/apiKey */
    proxyUrl?: string;
    /** 直连模式的 API base, e.g. 'https://api.kaiyuanguji.com' or 'http://122.51.91.177:7700' */
    baseUrl?: string;
    /** Read-only key（不要用 master key）。可空 — 此时不发 Authorization 头 */
    apiKey?: string;
    /** 单次请求超时，默认 2000 ms */
    timeoutMs?: number;
    /** 连续失败多少次进入降级模式，默认 3 */
    failuresBeforeBreak?: number;
    /** 降级期持续时长（ms），过期后允许重试 L1，默认 5 分钟 */
    breakerCooldownMs?: number;
    /** 调试日志 */
    debug?: boolean;
}

interface MeiliHit {
    id: string;
    type: 'work' | 'book' | 'collection' | 'entity';
    /** 条目是否仍在 draft 仓。索引重建前的旧文档没有这个字段 */
    is_draft?: boolean;
    title?: string;
    primary_name?: string;
    author?: string;
    dynasty?: string;
    era?: string;
    sort_year?: number;
    role?: string;
    edition?: string;
    subtype?: string;
    juan_count?: number;
    has_text?: boolean;
    has_image?: boolean;
    has_collated?: boolean;
    /** 部类一级、存佚（只有 works 有；重建索引后才出现） */
    classification?: string;
    loss_status?: string;
    birth_year?: number;
    death_year?: number;
    cbdb_id?: number;
    completeness?: number;
    /** 简介命中片段（A4，2026-09-27）：仅 works/books 请求了 attributesToHighlight 时才有 */
    _formatted?: { description_search?: string };
}

// 只有 works/books 有 description_search 字段（A4 精简版口径，见 indexer/full-reindex.mjs
// 的 SETTINGS），collections/entities 没有这个字段，不用带这几个搜索参数。
const DESCRIPTION_HIGHLIGHT_INDICES = new Set(['works', 'books']);
const DESCRIPTION_CROP_LENGTH = 80;

class CircuitBreaker {
    private failures = 0;
    private openUntil = 0;

    constructor(
        private readonly threshold: number,
        private readonly cooldownMs: number,
    ) {}

    canCall(): boolean {
        if (Date.now() < this.openUntil) return false;
        return true;
    }

    recordSuccess(): void {
        this.failures = 0;
        this.openUntil = 0;
    }

    recordFailure(): void {
        this.failures++;
        if (this.failures >= this.threshold) {
            this.openUntil = Date.now() + this.cooldownMs;
        }
    }

    /** 配置类永久故障（401/403）：不等阈值，立即进入降级期 */
    forceOpen(): void {
        this.failures = this.threshold;
        this.openUntil = Date.now() + this.cooldownMs;
    }

    state(): { open: boolean; failures: number; cooldownRemaining: number } {
        return {
            open: Date.now() < this.openUntil,
            failures: this.failures,
            cooldownRemaining: Math.max(0, this.openUntil - Date.now()),
        };
    }
}

// 全局 breaker（单例 — 同一域名只跟踪一份状态）
const breaker = new CircuitBreaker(3, 5 * 60_000);

// ─── 降级状态（页面据此显示「简易搜索」提示） ───

let degraded = false;
const degradedListeners = new Set<(d: boolean) => void>();

function setDegraded(d: boolean): void {
    if (d === degraded) return;
    degraded = d;
    for (const fn of degradedListeners) fn(d);
}

/** 当前搜索是否在走 L2 兜底（L1 故障） */
export function isSearchDegraded(): boolean {
    return degraded;
}

/** 订阅降级状态变化；返回取消订阅函数 */
export function subscribeSearchDegraded(fn: (d: boolean) => void): () => void {
    degradedListeners.add(fn);
    return () => { degradedListeners.delete(fn); };
}

interface ProxyResult {
    indexUid: string;
    hits: MeiliHit[];
    estimatedTotalHits: number;
}

function hitToEntry(h: MeiliHit): IndexEntry {
    return {
        id: h.id,
        type: h.type,
        title: h.title || h.primary_name || h.id,
        // 缺字段时回落 true，保持旧索引的既有行为；full-reindex 补上
        // is_draft 后，已升格条目才不会被误标成「草稿」
        isDraft: h.is_draft ?? true,
        author: h.author,
        dynasty: h.dynasty,
        era: h.era,
        sort_year: h.sort_year,
        role: h.role,
        edition: h.edition,
        subtype: h.subtype,
        juan_count: h.juan_count,
        has_text: h.has_text,
        has_image: h.has_image,
        has_collated: h.has_collated,
        classification: h.classification || undefined,
        loss_status: h.loss_status || undefined,
        primary_name: h.primary_name,
        birth_year: h.birth_year,
        death_year: h.death_year,
        cbdb_id: h.cbdb_id,
        // 只有真正命中简介（含高亮标记）才展示；没标记说明是从头裁出来的无关片段，
        // 展示反而误导用户以为搜中的是简介
        descriptionSnippet: h._formatted?.description_search?.includes(SNIPPET_MARK_START)
            ? h._formatted.description_search
            : undefined,
    };
}

/**
 * 包 base storage 一层 L1 拦截。base 应当已经被 wrapWithV2Search 包过
 * （提供 worker fallback）。
 *
 *   wrapWithMeiliSearch(wrapWithV2Search(bundleStorage), { baseUrl: ... })
 */
export function wrapWithMeiliSearch<T extends IndexStorage>(base: T, config: MeiliConfig): T {
    if (config.proxyUrl) return wrapWithSearchProxy(base, config);
    const baseUrl = (config.baseUrl ?? '').replace(/\/$/, '');
    // 5 秒留够海外冷启动余地：cache MISS 回源上海 ~600ms，上海机器繁忙时偶发到
    // 1-2s。2 秒太紧 → 4 个并发里只要一个超时整个 searchAll 就被认为失败。
    const timeoutMs = config.timeoutMs ?? 5000;
    const debug = config.debug ?? false;

    async function meiliSearch(indexUid: string, query: string, opts: { limit?: number; offset?: number } = {}) {
        // 用 GET 而不是 POST：CDN（EdgeOne 等）默认不缓存 POST，无法享受
        // 边缘 cache。Meili 同时支持两种方式，参数走 query string。
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(new DOMException('meili timeout', 'TimeoutError')), timeoutMs);
        try {
            const params = new URLSearchParams({
                q: query,
                limit: String(opts.limit ?? 5),
                offset: String(opts.offset ?? 0),
                // 网站搜索只暴露 production 条目；draft 混入是 2026-09 发现的回归。
                // 依赖 full-reindex.mjs 写入的 is_draft 字段，重建前的旧文档没有
                // 该字段时会被这条 filter 一并排除掉（Meili 对缺字段视为不匹配）。
                filter: 'is_draft = false',
            });
            if (DESCRIPTION_HIGHLIGHT_INDICES.has(indexUid)) {
                // 高亮标记用控制字符而非 <mark>：简介原文偶尔含 `<`/`>`，前端按
                // sentinel 切段渲染（book-index-ui 的 splitHighlightSnippet），
                // 不用 dangerouslySetInnerHTML，天然不怕原文里的尖括号。
                params.set('attributesToHighlight', 'description_search');
                params.set('attributesToCrop', 'description_search');
                params.set('cropLength', String(DESCRIPTION_CROP_LENGTH));
                params.set('highlightPreTag', SNIPPET_MARK_START);
                params.set('highlightPostTag', SNIPPET_MARK_END);
            }
            const r = await fetch(`${baseUrl}/indexes/${indexUid}/search?${params}`, {
                method: 'GET',
                signal: ctrl.signal,
                headers: {
                    ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
                },
            });
            if (!r.ok) {
                const err = new Error(`HTTP ${r.status}`) as Error & { status?: number };
                err.status = r.status;
                throw err;
            }
            return await r.json() as { hits: MeiliHit[]; estimatedTotalHits: number; processingTimeMs: number };
        } finally {
            clearTimeout(timer);
        }
    }

    const overrides: Partial<IndexStorage> = {
        async searchAll(query: string, limit: number = 5): Promise<GroupedSearchResult> {
            const q = query.trim();
            if (!q) {
                return {
                    works: [], books: [], collections: [], entities: [],
                    totalWorks: 0, totalBooks: 0, totalCollections: 0, totalEntities: 0,
                };
            }

            if (!breaker.canCall()) {
                if (debug) console.log('[meili] breaker open, → L2');
                return base.searchAll!(query, limit);
            }

            // 4 个 index 用 allSettled 而不是 all：单个分类失败不应让整个搜索看似无结果。
            // 部分成功的分类仍正常显示；全失败才认定为 L1 不可用。
            const settled = await Promise.allSettled([
                meiliSearch('works', q, { limit }),
                meiliSearch('books', q, { limit }),
                meiliSearch('collections', q, { limit }),
                meiliSearch('entities', q, { limit }),
            ]);
            const allFailed = settled.every(r => r.status === 'rejected');
            if (allFailed) {
                // 401/403 = key 缺失/失效等配置类故障，不会自愈：立即熔断并透传 L2，
                // 否则前几次搜索会白白返回空结果（2026-08 线上事故：secret 未配，
                // 构建时 key 为空，用户看到的就是「搜索坏了」）。
                const authFailed = settled.some(r =>
                    r.status === 'rejected' && ((r.reason as any)?.status === 401 || (r.reason as any)?.status === 403));
                if (authFailed) breaker.forceOpen();
                else breaker.recordFailure();
                if (debug) console.warn('[meili] searchAll all 4 failed:', (settled[0] as any).reason?.message);
                if (breaker.state().open) return base.searchAll!(query, limit);
                return {
                    works: [], books: [], collections: [], entities: [],
                    totalWorks: 0, totalBooks: 0, totalCollections: 0, totalEntities: 0,
                };
            }
            breaker.recordSuccess();
            const empty = { hits: [] as MeiliHit[], estimatedTotalHits: 0, processingTimeMs: 0 };
            const [worksR, booksR, collectionsR, entitiesR] = settled.map(r =>
                r.status === 'fulfilled' ? r.value : empty,
            );
            return {
                works: worksR.hits.map(hitToEntry),
                books: booksR.hits.map(hitToEntry),
                collections: collectionsR.hits.map(hitToEntry),
                entities: entitiesR.hits.map(hitToEntry),
                totalWorks: worksR.estimatedTotalHits,
                totalBooks: booksR.estimatedTotalHits,
                totalCollections: collectionsR.estimatedTotalHits,
                totalEntities: entitiesR.estimatedTotalHits,
            };
        },

        async search(query: string, type: IndexType, options: LoadOptions): Promise<PageResult<IndexEntry>> {
            const q = query.trim();
            const page = options.page ?? 1;
            const pageSize = options.pageSize ?? 50;
            if (!q) return base.search(query, type, options);

            if (!breaker.canCall()) {
                if (debug) console.log('[meili] breaker open, → L2');
                return base.search(query, type, options);
            }

            // type → meili index 名映射
            const indexUid = type === 'work' ? 'works'
                : type === 'book' ? 'books'
                : type === 'collection' ? 'collections'
                : type === 'entity' ? 'entities'
                : 'works';

            try {
                const r = await meiliSearch(indexUid, q, {
                    limit: pageSize,
                    offset: (page - 1) * pageSize,
                });
                breaker.recordSuccess();
                return {
                    entries: r.hits.map(hitToEntry),
                    total: r.estimatedTotalHits,
                    page,
                    pageSize,
                };
            } catch (e: any) {
                if (e?.status === 401 || e?.status === 403) breaker.forceOpen();
                else breaker.recordFailure();
                if (debug) console.warn('[meili] search failed, → L2:', e.message);
                // search() 单 type 没 partial 余地，失败直接 fallback worker。
                // 这条路径只在用户点"查看全部"后翻页才走，单次触发 worker 加载可接受。
                return base.search(query, type, options);
            }
        },
    };

    return withOverrides(base, overrides);
}

function withOverrides<T extends IndexStorage>(base: T, overrides: Partial<IndexStorage>): T {
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

const FILTER_UNAVAILABLE = '搜索服务暂时不可用，筛选需要完整搜索，请稍后再试。';
const FILTER_TOO_MANY = '筛选条件太多，请减少几项后再试。';

/** 带筛选的请求失败：400＝条件本身不被接受（超限等），其余＝服务不可用；都给用户一句人话 */
function filterError(e: unknown): Error {
    return new Error((e as { status?: number })?.status === 400 ? FILTER_TOO_MANY : FILTER_UNAVAILABLE);
}

const TYPE_TO_INDEX: Record<string, string> = {
    work: 'works', book: 'books', collection: 'collections', entity: 'entities',
};

/**
 * 代理模式：L1 走同站 /api/search。
 *
 * 与直连模式的区别：
 *   - 四类索引一次请求（代理在服务端 multi-search），省三个往返；
 *   - 失败（代理 503／超时／网络错）当次就透传 L2，不再「先返回空结果」——
 *     L2 已是轻量分片（书名＋作者），Meili 停机时用户仍能按书名搜到；
 *   - breaker 仍在：连续失败后冷却期内不再请求代理，直接 L2，省得每次等超时。
 */
function wrapWithSearchProxy<T extends IndexStorage>(base: T, config: MeiliConfig): T {
    const proxyUrl = config.proxyUrl!;
    // 代理对上游有 2 s 超时，自身再留 1 s 余量
    const timeoutMs = config.timeoutMs ?? 3000;
    const debug = config.debug ?? false;

    async function proxySearch(params: Record<string, string>): Promise<ProxyResult[]> {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(new DOMException('search proxy timeout', 'TimeoutError')), timeoutMs);
        try {
            const r = await fetch(`${proxyUrl}?${new URLSearchParams(params)}`, {
                method: 'GET',
                signal: ctrl.signal,
            });
            if (!r.ok) {
                const err = new Error(`HTTP ${r.status}`) as Error & { status?: number };
                err.status = r.status;
                throw err;
            }
            const data = await r.json() as { results?: ProxyResult[] };
            if (!Array.isArray(data.results)) throw new Error('bad proxy response');
            return data.results;
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * 带筛选的「全部」：POST multi-search，一次请求里每类索引各带自己的 filter
     * （各类能筛的字段不同，见 book-index-ui 的 FILTER_SUPPORT）；不支持已选字段的类不发、按 0 条。
     */
    async function proxyMultiSearch(q: string, limit: number, offset: number, filters: SearchFilters): Promise<ProxyResult[]> {
        const queries: { indexUid: string; q: string; limit: number; offset: number; filter?: string }[] = [];
        const empty: ProxyResult[] = [];
        for (const [type, uid] of Object.entries(TYPE_TO_INDEX) as [IndexType, string][]) {
            const f = buildMeiliFilter(filters, type);
            if (f === null) { empty.push({ indexUid: uid, hits: [], estimatedTotalHits: 0 }); continue; }
            queries.push({ indexUid: uid, q, limit, offset, ...(f ? { filter: f } : {}) });
        }
        if (queries.length === 0) return empty;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(new DOMException('search proxy timeout', 'TimeoutError')), timeoutMs);
        try {
            const r = await fetch(proxyUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ queries }),
                signal: ctrl.signal,
            });
            if (!r.ok) {
                const err = new Error(`HTTP ${r.status}`) as Error & { status?: number };
                err.status = r.status;
                throw err;
            }
            const data = await r.json() as { results?: ProxyResult[] };
            if (!Array.isArray(data.results)) throw new Error('bad proxy response');
            return [...data.results, ...empty];
        } finally {
            clearTimeout(timer);
        }
    }

    function onFailure(e: unknown, where: string): void {
        const status = (e as { status?: number })?.status;
        // 400 是请求本身的问题（如查询超长），不代表 L1 挂了，不计入熔断
        if (status !== 400) breaker.recordFailure();
        setDegraded(true);
        if (debug) console.warn(`[search-proxy] ${where} failed, → L2:`, (e as Error)?.message);
    }

    const overrides: Partial<IndexStorage> = {
        async searchAll(query: string, limit: number = 5, filters?: SearchFilters): Promise<GroupedSearchResult> {
            const q = query.trim();
            if (!q) {
                return {
                    works: [], books: [], collections: [], entities: [],
                    totalWorks: 0, totalBooks: 0, totalCollections: 0, totalEntities: 0,
                };
            }
            const filtered = !!filters && hasActiveFilters(filters);
            // 简易搜索（L2）不认筛选：带筛选时不退回它，免得用户看到「筛了但没筛」的结果
            if (!breaker.canCall()) {
                setDegraded(true);
                if (filtered) throw new Error(FILTER_UNAVAILABLE);
                return base.searchAll!(query, limit);
            }
            try {
                const results = filtered
                    ? await proxyMultiSearch(q, limit, 0, filters!)
                    : await proxySearch({ q, limit: String(limit) });
                breaker.recordSuccess();
                setDegraded(false);
                const by = new Map(results.map(r => [r.indexUid, r]));
                const pick = (uid: string) => by.get(uid) ?? { indexUid: uid, hits: [], estimatedTotalHits: 0 };
                const [w, b, c, e] = ['works', 'books', 'collections', 'entities'].map(pick);
                return {
                    works: w.hits.map(hitToEntry),
                    books: b.hits.map(hitToEntry),
                    collections: c.hits.map(hitToEntry),
                    entities: e.hits.map(hitToEntry),
                    totalWorks: w.estimatedTotalHits,
                    totalBooks: b.estimatedTotalHits,
                    totalCollections: c.estimatedTotalHits,
                    totalEntities: e.estimatedTotalHits,
                };
            } catch (err) {
                onFailure(err, 'searchAll');
                if (filtered) throw filterError(err);
                return base.searchAll!(query, limit);
            }
        },

        async search(query: string, type: IndexType, options: LoadOptions): Promise<PageResult<IndexEntry>> {
            const q = query.trim();
            const page = options.page ?? 1;
            const pageSize = options.pageSize ?? 50;
            if (!q) return base.search(query, type, options);
            const filtered = !!options.filters && hasActiveFilters(options.filters);
            const filterStr = filtered ? buildMeiliFilter(options.filters!, type) : '';
            // 这类索引不支持已选的筛选字段（如版本没有部类）：没有可比较的结果，按 0 条
            if (filterStr === null) return { entries: [], total: 0, page, pageSize };
            if (!breaker.canCall()) {
                setDegraded(true);
                if (filtered) throw new Error(FILTER_UNAVAILABLE);
                return base.search(query, type, options);
            }
            try {
                const [r] = await proxySearch({
                    q,
                    index: TYPE_TO_INDEX[type] ?? 'works',
                    limit: String(pageSize),
                    offset: String((page - 1) * pageSize),
                    ...(filterStr ? { filter: filterStr } : {}),
                });
                breaker.recordSuccess();
                setDegraded(false);
                return {
                    entries: (r?.hits ?? []).map(hitToEntry),
                    total: r?.estimatedTotalHits ?? 0,
                    page,
                    pageSize,
                };
            } catch (err) {
                onFailure(err, 'search');
                if (filtered) throw filterError(err);
                return base.search(query, type, options);
            }
        },
    };

    return withOverrides(base, overrides);
}

/** 给外部查询当前 breaker 状态（埋点用） */
export function getMeiliBreakerState() {
    return breaker.state();
}
