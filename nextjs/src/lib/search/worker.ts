/// <reference lib="webworker" />
/**
 * 搜索 Worker：在单独线程跑 MiniSearch，避免主线程卡顿。
 *
 * L0 索引字段：title_search, author_search。
 * work 类型分 4 个分片并行加载，搜索时跨片合并结果。
 *
 * 协议（postMessage）:
 *   req { id, type: 'init', baseUrl }                           → { id, ok }
 *   req { id, type: 'searchAll', query, limit }                 → { id, result }
 *   req { id, type: 'searchEntries', query, entryType, page, pageSize } → { id, result }
 */

import MiniSearch, { type SearchResult } from 'minisearch';
import { tokenize, hasCjkBigram } from './normalize.js';

type EntryType = 'work' | 'book' | 'collection' | 'entity';

interface StoredFields {
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
}

interface MetaIndex {
    type: EntryType;
    file?: string;
    shards?: string[];
    docCount: number;
}

interface Meta {
    version: number;
    indices: MetaIndex[];
}

type InitReq = { id: number; type: 'init'; baseUrl: string };
type SearchAllReq = { id: number; type: 'searchAll'; query: string; limit: number };
type SearchEntriesReq = {
    id: number;
    type: 'searchEntries';
    query: string;
    entryType: EntryType;
    page: number;
    pageSize: number;
};
type Req = InitReq | SearchAllReq | SearchEntriesReq;

const engines = new Map<EntryType, MiniSearch<StoredFields>[]>();
let initPromise: Promise<void> | null = null;

export function msOptions() {
    return {
        idField: 'id',
        fields: ['title_search', 'author_search', 'aliases_search'],
        storeFields: [
            'id', 'type', 'title', 'author', 'dynasty', 'role', 'edition',
            'additional_titles', 'attached_texts', 'juan_count',
            'has_text', 'has_image', 'has_collated',
            'subtype', 'primary_name', 'birth_year', 'death_year', 'cbdb_id',
        ],
        tokenize: (text: string) => tokenize(text),
        processTerm: (term: string) => term,
    };
}

export async function init(baseUrl: string) {
    if (initPromise) return initPromise;
    initPromise = (async () => {
        const metaRes = await fetch(`${baseUrl}/meta.json`);
        if (!metaRes.ok) throw new Error(`failed to load meta.json: ${metaRes.status}`);
        const meta = (await metaRes.json()) as Meta;

        await Promise.all(
            meta.indices.map(async (idx) => {
                const files = idx.shards ?? (idx.file ? [idx.file] : []);
                const shardEngines = await Promise.all(
                    files.map(async (f) => {
                        const res = await fetch(`${baseUrl}/${f}`);
                        if (!res.ok) throw new Error(`failed to load ${f}: ${res.status}`);
                        const json = await res.text();
                        return MiniSearch.loadJSON<StoredFields>(json, msOptions());
                    }),
                );
                engines.set(idx.type, shardEngines);
            }),
        );
    })();
    return initPromise;
}

function ensureReady(): void {
    if (engines.size === 0) throw new Error('search worker not initialized');
}

/** 测试用：注入预构建的 MiniSearch 引擎，跳过 fetch */
export function _setEnginesForTesting(map: Map<EntryType, MiniSearch<StoredFields>[]>): void {
    engines.clear();
    for (const [k, v] of map) engines.set(k, v);
}

/** 测试用：重置 module 状态（init promise + engines） */
export function _resetForTesting(): void {
    engines.clear();
    initPromise = null;
}

type Hit = StoredFields & { score: number };

export function mapHits(results: SearchResult[]): Hit[] {
    return results.map(r => ({
        id: r.id as string,
        type: r.type as EntryType,
        title: r.title as string,
        author: r.author as string | undefined,
        dynasty: r.dynasty as string | undefined,
        role: r.role as string | undefined,
        edition: r.edition as string | undefined,
        additional_titles: r.additional_titles as string[] | undefined,
        attached_texts: r.attached_texts as string[] | undefined,
        juan_count: r.juan_count as number | undefined,
        has_text: r.has_text as boolean | undefined,
        has_image: r.has_image as boolean | undefined,
        has_collated: r.has_collated as boolean | undefined,
        subtype: r.subtype as string | undefined,
        primary_name: r.primary_name as string | undefined,
        birth_year: r.birth_year as number | undefined,
        death_year: r.death_year as number | undefined,
        cbdb_id: r.cbdb_id as number | undefined,
        score: r.score,
    }));
}

/**
 * 跨所有分片搜索：AND 严格 → MSM bigram 回退。
 */
export function searchAllShards(shards: MiniSearch<StoredFields>[], q: string): Hit[] {
    const len = Array.from(q).filter(c => /\S/.test(c)).length;
    const enableFuzzy = len >= 3;
    const qTokens = tokenize(q);
    const prefixForStrict = !hasCjkBigram(qTokens);

    // 严格 AND，跨片合并
    const strictAll: SearchResult[] = [];
    for (const engine of shards) {
        const hits = engine.search(q, {
            combineWith: 'AND',
            prefix: prefixForStrict,
            fuzzy: enableFuzzy ? 0.2 : false,
        });
        strictAll.push(...hits);
    }
    if (strictAll.length > 0) {
        strictAll.sort((a, b) => b.score - a.score);
        return mapHits(strictAll);
    }

    // MSM 回退：每个 bigram 跨片搜索，累计命中数
    const bigrams = Array.from(new Set(qTokens.filter(t => Array.from(t).length >= 2)));
    if (bigrams.length < 2) return [];

    const statsMap = new Map<string, { hits: number; score: number; doc: SearchResult }>();
    for (const bg of bigrams) {
        for (const engine of shards) {
            const hits = engine.search(bg, { combineWith: 'AND', prefix: false, fuzzy: false });
            for (const h of hits) {
                const key = h.id as string;
                const prev = statsMap.get(key);
                if (prev) {
                    prev.hits++;
                    prev.score += h.score;
                } else {
                    statsMap.set(key, { hits: 1, score: h.score, doc: h });
                }
            }
        }
    }

    const all = [...statsMap.values()];
    const startMin = Math.max(1, Math.ceil(bigrams.length / 2));
    for (let m = startMin; m >= 1; m--) {
        const layer = all.filter(s => s.hits >= m);
        if (layer.length > 0) {
            layer.sort((a, b) => (b.hits - a.hits) || (b.score - a.score));
            return mapHits(layer.map(s => ({ ...s.doc, score: s.hits * 100 + s.score })));
        }
    }
    return [];
}

export function runSearchAll(query: string): Map<EntryType, Hit[]> {
    ensureReady();
    const q = query.trim();
    const out = new Map<EntryType, Hit[]>();
    if (!q) return out;
    for (const [type, shards] of engines) {
        out.set(type, searchAllShards(shards, q));
    }
    return out;
}

export function runSearchType(query: string, type: EntryType): Hit[] {
    ensureReady();
    const q = query.trim();
    if (!q) return [];
    const shards = engines.get(type);
    if (!shards) return [];
    return searchAllShards(shards, q);
}

export function groupByType(byType: Map<EntryType, Hit[]>, limit: number) {
    const works = byType.get('work') || [];
    const books = byType.get('book') || [];
    const collections = byType.get('collection') || [];
    const entities = byType.get('entity') || [];
    return {
        works: works.slice(0, limit),
        books: books.slice(0, limit),
        collections: collections.slice(0, limit),
        entities: entities.slice(0, limit),
        totalWorks: works.length,
        totalBooks: books.length,
        totalCollections: collections.length,
        totalEntities: entities.length,
    };
}

/** 处理一条 worker 消息。导出便于直接单测，也供 self.onmessage 转发。 */
export async function handleMessage(msg: Req): Promise<unknown> {
    if (msg.type === 'init') {
        await init(msg.baseUrl);
        return { id: msg.id, ok: true };
    }
    if (msg.type === 'searchAll') {
        const byType = runSearchAll(msg.query);
        return { id: msg.id, result: groupByType(byType, msg.limit) };
    }
    if (msg.type === 'searchEntries') {
        const hits = runSearchType(msg.query, msg.entryType);
        const total = hits.length;
        const start = (msg.page - 1) * msg.pageSize;
        return {
            id: msg.id,
            result: {
                hits: hits.slice(start, start + msg.pageSize),
                total,
                page: msg.page,
                pageSize: msg.pageSize,
            },
        };
    }
    throw new Error(`unknown message type: ${(msg as { type: string }).type}`);
}

// 仅在真实 Worker 环境注册 message handler；jsdom / Node 测试环境跳过避免污染
/* istanbul ignore next: worker bundle only — handleMessage 已被独立测试覆盖 */
if (typeof self !== 'undefined' && typeof (self as { importScripts?: unknown }).importScripts === 'function') {
    self.addEventListener('message', async (ev: MessageEvent<Req>) => {
        const msg = ev.data;
        try {
            const resp = await handleMessage(msg);
            (self as unknown as Worker).postMessage(resp);
        } catch (err) {
            (self as unknown as Worker).postMessage({
                id: (msg as { id: number }).id,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    });
}
