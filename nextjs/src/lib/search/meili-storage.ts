/**
 * Meilisearch storage 包装器（L1 层）
 *
 * Hybrid 架构：
 *   L1: 上海云 Meilisearch（全文 + 拼音 + 异体 + completeness 排序）
 *   L2: 现有 worker 索引（v2-storage 包装的 base）— 任何 L1 错误时透传到 L2
 *
 * 客户端只在 searchAll / search 上做 L1，其他方法（getEntry / getCounts /
 * getCollatedJuan 等）暂保持透传到 L2。Phase 4 再把详情类也加 L1。
 *
 * Circuit breaker：连续 N 次失败后短暂不再访问 L1，直接走 L2，避免
 * 每次搜索都等 2 秒超时。
 */

import type { IndexStorage } from 'book-index-ui/storage';
import type { IndexEntry, IndexType, PageResult, LoadOptions, GroupedSearchResult } from 'book-index-ui';

export interface MeiliConfig {
    /** API base, e.g. 'https://api.kaiyuanguji.com' or 'http://81.69.15.227:7700' */
    baseUrl: string;
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
    title?: string;
    primary_name?: string;
    author?: string;
    dynasty?: string;
    role?: string;
    edition?: string;
    subtype?: string;
    juan_count?: number;
    has_text?: boolean;
    has_image?: boolean;
    has_collated?: boolean;
    birth_year?: number;
    death_year?: number;
    cbdb_id?: number;
    completeness?: number;
}

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

/**
 * 包 base storage 一层 L1 拦截。base 应当已经被 wrapWithV2Search 包过
 * （提供 worker fallback）。
 *
 *   wrapWithMeiliSearch(wrapWithV2Search(bundleStorage), { baseUrl: ... })
 */
export function wrapWithMeiliSearch<T extends IndexStorage>(base: T, config: MeiliConfig): T {
    const baseUrl = config.baseUrl.replace(/\/$/, '');
    // 5 秒留够海外冷启动余地：cache MISS 回源上海 ~600ms，上海机器繁忙时偶发到
    // 1-2s。2 秒太紧 → 4 个并发里只要一个超时整个 searchAll 就被认为失败。
    const timeoutMs = config.timeoutMs ?? 5000;
    const debug = config.debug ?? false;

    function hitToEntry(h: MeiliHit): IndexEntry {
        return {
            id: h.id,
            type: h.type,
            title: h.title || h.primary_name || h.id,
            isDraft: true,
            author: h.author,
            dynasty: h.dynasty,
            role: h.role,
            edition: h.edition,
            subtype: h.subtype,
            juan_count: h.juan_count,
            has_text: h.has_text,
            has_image: h.has_image,
            has_collated: h.has_collated,
            primary_name: h.primary_name,
            birth_year: h.birth_year,
            death_year: h.death_year,
            cbdb_id: h.cbdb_id,
        };
    }

    async function meiliSearch(indexUid: string, query: string, opts: { limit?: number; offset?: number } = {}) {
        // 用 GET 而不是 POST：CDN（EdgeOne 等）默认不缓存 POST，无法享受
        // 边缘 cache。Meili 同时支持两种方式，参数走 query string。
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const params = new URLSearchParams({
                q: query,
                limit: String(opts.limit ?? 5),
                offset: String(opts.offset ?? 0),
            });
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

/** 给外部查询当前 breaker 状态（埋点用） */
export function getMeiliBreakerState() {
    return breaker.state();
}
