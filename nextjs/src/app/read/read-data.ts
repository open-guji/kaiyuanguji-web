/**
 * 阅读首页的服务端取数：Meili GET 查询（只读、公开搜索 key）。
 * 与浏览器端搜索同一个源（NEXT_PUBLIC_MEILI_URL / NEXT_PUBLIC_MEILI_KEY，构建期内联）。
 * 没配置时返回 null，页面显示「暂时无法加载」，不当成没有数据。
 * 网络错与 5xx 抛错走错误页，不缓存成空页。
 */
import { READ_MAX_HITS, READ_PAGE_SIZE, type ReadCard } from './read-route';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ReadFetcherOptions {
    baseUrl: string;
    apiKey: string;
    fetch?: FetchLike;
    timeoutMs?: number;
}

interface MeiliHit {
    id: string;
    title?: string;
    author?: string;
    dynasty?: string;
    juan_count?: number;
    has_collated?: boolean;
    has_text?: boolean;
}

interface MeiliResp {
    hits: MeiliHit[];
    estimatedTotalHits?: number;
    facetDistribution?: Record<string, Record<string, number>>;
}

const FIELDS = 'id,title,author,dynasty,juan_count,has_collated,has_text';
const BASE_FILTER = 'is_draft = false';
/** Work：有整理本或有全文；Book：有全文 */
const WORK_READABLE = `${BASE_FILTER} AND (has_collated = true OR has_text = true)`;
const BOOK_READABLE = `${BASE_FILTER} AND has_text = true`;

function toCard(h: MeiliHit): ReadCard {
    return {
        id: h.id,
        title: h.title || h.id,
        author: h.author || undefined,
        dynasty: h.dynasty || undefined,
        juanCount: typeof h.juan_count === 'number' && h.juan_count > 0 ? h.juan_count : undefined,
        hasCollated: !!h.has_collated,
        hasText: !!h.has_text,
    };
}

export function createReadFetcher(opts: ReadFetcherOptions) {
    const base = opts.baseUrl.replace(/\/$/, '');
    const doFetch: FetchLike = opts.fetch ?? ((u, i) => fetch(u, i));
    const timeoutMs = opts.timeoutMs ?? 8_000;

    async function search(index: 'works' | 'books', params: Record<string, string>): Promise<MeiliResp> {
        const qs = new URLSearchParams({ q: '', ...params });
        const res = await doFetch(`${base}/indexes/${index}/search?${qs}`, {
            method: 'GET',
            headers: { Authorization: `Bearer ${opts.apiKey}` },
            signal: AbortSignal.timeout(timeoutMs),
            next: { revalidate: 300 },
        } as RequestInit);
        if (!res.ok) throw new Error(`meili ${index} HTTP ${res.status}`);
        return (await res.json()) as MeiliResp;
    }

    return {
        /** 有整理本的作品（全部，约 60 部） */
        async getCollated(): Promise<ReadCard[]> {
            const r = await search('works', {
                filter: `${BASE_FILTER} AND has_collated = true`,
                limit: '200',
                attributesToRetrieve: FIELDS,
            });
            return r.hits.map(toCard);
        },
        /** 有全文的书本（全部，约 35 部） */
        async getBooks(): Promise<ReadCard[]> {
            const r = await search('books', { filter: BOOK_READABLE, limit: '200', attributesToRetrieve: FIELDS });
            return r.hits.map(toCard);
        },
        /** 作品按朝代的数量（有整理本或全文） */
        async getDynastyFacet(): Promise<Record<string, number>> {
            const r = await search('works', { filter: WORK_READABLE, limit: '0', facets: 'dynasty' });
            return r.facetDistribution?.dynasty ?? {};
        },
        /** 某朝代第 page 页；超出 1000 条上限的页返回空 */
        async getDynastyPage(dynasty: string, page: number): Promise<ReadCard[]> {
            const offset = (page - 1) * READ_PAGE_SIZE;
            if (offset >= READ_MAX_HITS) return [];
            const r = await search('works', {
                filter: `${WORK_READABLE} AND dynasty = "${dynasty}"`,
                limit: String(Math.min(READ_PAGE_SIZE, READ_MAX_HITS - offset)),
                offset: String(offset),
                attributesToRetrieve: FIELDS,
            });
            return r.hits.map(toCard);
        },
    };
}

let shared: ReturnType<typeof createReadFetcher> | null | undefined;

/** 进程级单例；没配 Meili 返回 null */
export function getReadFetcher() {
    if (shared === undefined) {
        const baseUrl = process.env.NEXT_PUBLIC_MEILI_URL || '';
        const apiKey = process.env.NEXT_PUBLIC_MEILI_KEY || '';
        shared = baseUrl && apiKey ? createReadFetcher({ baseUrl, apiKey }) : null;
    }
    return shared;
}
