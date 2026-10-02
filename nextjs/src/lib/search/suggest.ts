/**
 * 检索框候选（overview#342）：首页、元数据首页的检索框边输边出条目候选。
 *
 * 直接调同站搜索代理 /api/search（edge-functions/api/search.js，四类索引一次请求），不引 book-index-ui：
 * 那是单文件大包（顶层就引 opencc、react-markdown），首页引了首屏 JS 会大几百 KB。
 * 代理不通（本地 dev 没有边缘函数、Meili 故障）时不出候选，表单照常提交到结果页，结果页自有 L2 兜底。
 *
 * 书名等显示字段跟繁简偏好走：请求带 locale，zh-Hans 时由代理在服务端转简体（与 lib/server/simplify 同一套字表），
 * 首页仍不必引 opencc。
 *
 * 候选口径与结果页 book-index-ui 的 SearchInput 一致：作品、书、丛编、人物依次排，取前 8 条；
 * 空框聚焦出最近检索，历史与它共用 localStorage 键 'bim-search-history'，两边互通。
 */

import type { SiteLocale } from '@/lib/site-locale';

export type SuggestType = 'work' | 'book' | 'collection' | 'entity';

export interface SuggestEntry {
    id: string;
    type: SuggestType;
    title: string;
    author?: string;
    dynasty?: string;
}

const SEARCH_PROXY_URL = process.env.NEXT_PUBLIC_SEARCH_PROXY_URL || '/api/search';
export const SUGGEST_LIMIT = 8;
/** 代理对上游 2 s 超时，这里多留 1 s（与 transport.ts 一致） */
const TIMEOUT_MS = 3000;
const INDEX_ORDER = ['works', 'books', 'collections', 'entities'] as const;

interface ProxyHit {
    id: string;
    type: SuggestType;
    title?: string;
    primary_name?: string;
    author?: string;
    dynasty?: string;
}

/** 代理响应 → 候选：按类排序后取前 SUGGEST_LIMIT 条 */
export function toSuggestions(data: unknown): SuggestEntry[] {
    const results = (data as { results?: { indexUid: string; hits?: ProxyHit[] }[] } | null)?.results;
    if (!Array.isArray(results)) throw new Error('bad proxy response');
    const out: SuggestEntry[] = [];
    for (const uid of INDEX_ORDER) {
        for (const h of results.find((r) => r.indexUid === uid)?.hits ?? []) {
            out.push({
                id: h.id,
                type: h.type,
                title: h.title || h.primary_name || h.id,
                author: h.author || undefined,
                dynasty: h.dynasty || undefined,
            });
        }
    }
    return out.slice(0, SUGGEST_LIMIT);
}

// 同一检索词不重复请求（退格再输回来、上下翻历史都常见）
const cache = new Map<string, SuggestEntry[]>();
const CACHE_MAX = 50;

export async function fetchSuggestions(query: string, locale: SiteLocale, signal?: AbortSignal): Promise<SuggestEntry[]> {
    const q = query.trim();
    if (!q) return [];
    const key = `${locale}|${q}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort);
    try {
        const params = new URLSearchParams({ q, limit: String(SUGGEST_LIMIT), locale });
        const r = await fetch(`${SEARCH_PROXY_URL}?${params}`, { signal: ctrl.signal });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const list = toSuggestions(await r.json());
        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
        cache.set(key, list);
        return list;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
    }
}

/** 测试用 */
export function clearSuggestCache(): void {
    cache.clear();
}

// ─── 最近检索（与 book-index-ui SearchInput 同一个键、同一个上限） ───

const HISTORY_KEY = 'bim-search-history';
const HISTORY_MAX = 10;

export function readSearchHistory(): string[] {
    try {
        const v = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
        return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch {
        return [];
    }
}

function writeSearchHistory(list: string[]): void {
    try {
        if (list.length) localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
        else localStorage.removeItem(HISTORY_KEY);
    } catch {
        /* 无痕模式等：存不下就不记 */
    }
}

export function pushSearchHistory(query: string): void {
    const q = query.trim();
    if (!q) return;
    writeSearchHistory([q, ...readSearchHistory().filter((x) => x !== q)].slice(0, HISTORY_MAX));
}

export function removeSearchHistory(query: string): void {
    writeSearchHistory(readSearchHistory().filter((x) => x !== query));
}

export function clearSearchHistory(): void {
    writeSearchHistory([]);
}
