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

type EntryType = 'work' | 'book' | 'collection';

interface StoredFields {
    id: string;
    type: EntryType;
    title: string;
    author: string;
    dynasty: string;
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

function msOptions() {
    return {
        idField: 'id',
        fields: ['title_search', 'author_search'],
        storeFields: ['id', 'type', 'title', 'author', 'dynasty'],
        tokenize: (text: string) => tokenize(text),
        processTerm: (term: string) => term,
    };
}

async function init(baseUrl: string) {
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

type Hit = { id: string; type: EntryType; title: string; author: string; dynasty: string; score: number };

function mapHits(results: SearchResult[]): Hit[] {
    return results.map(r => ({
        id: r.id as string,
        type: r.type as EntryType,
        title: r.title as string,
        author: r.author as string,
        dynasty: r.dynasty as string,
        score: r.score,
    }));
}

/**
 * 跨所有分片搜索：AND 严格 → MSM bigram 回退。
 */
function searchAllShards(shards: MiniSearch<StoredFields>[], q: string): Hit[] {
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

function runSearchAll(query: string): Map<EntryType, Hit[]> {
    ensureReady();
    const q = query.trim();
    const out = new Map<EntryType, Hit[]>();
    if (!q) return out;
    for (const [type, shards] of engines) {
        out.set(type, searchAllShards(shards, q));
    }
    return out;
}

function runSearchType(query: string, type: EntryType): Hit[] {
    ensureReady();
    const q = query.trim();
    if (!q) return [];
    const shards = engines.get(type);
    if (!shards) return [];
    return searchAllShards(shards, q);
}

function groupByType(byType: Map<EntryType, Hit[]>, limit: number) {
    const works = byType.get('work') || [];
    const books = byType.get('book') || [];
    const collections = byType.get('collection') || [];
    return {
        works: works.slice(0, limit),
        books: books.slice(0, limit),
        collections: collections.slice(0, limit),
        totalWorks: works.length,
        totalBooks: books.length,
        totalCollections: collections.length,
    };
}

self.addEventListener('message', async (ev: MessageEvent<Req>) => {
    const msg = ev.data;
    try {
        if (msg.type === 'init') {
            await init(msg.baseUrl);
            (self as unknown as Worker).postMessage({ id: msg.id, ok: true });
            return;
        }
        if (msg.type === 'searchAll') {
            const byType = runSearchAll(msg.query);
            (self as unknown as Worker).postMessage({ id: msg.id, result: groupByType(byType, msg.limit) });
            return;
        }
        if (msg.type === 'searchEntries') {
            const hits = runSearchType(msg.query, msg.entryType);
            const total = hits.length;
            const start = (msg.page - 1) * msg.pageSize;
            (self as unknown as Worker).postMessage({
                id: msg.id,
                result: {
                    hits: hits.slice(start, start + msg.pageSize),
                    total,
                    page: msg.page,
                    pageSize: msg.pageSize,
                },
            });
            return;
        }
        throw new Error(`unknown message type: ${(msg as { type: string }).type}`);
    } catch (err) {
        (self as unknown as Worker).postMessage({
            id: (msg as { id: number }).id,
            error: err instanceof Error ? err.message : String(err),
        });
    }
});
