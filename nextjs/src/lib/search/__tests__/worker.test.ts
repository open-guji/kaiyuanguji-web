/**
 * worker.ts 单测：核心搜索 / 排序 / 协议处理
 *
 * 关键覆盖：
 *   - searchAllShards: strict AND / 跨片合并 / MSM bigram 回退 / 单字 query 兜底
 *   - runSearchAll/Type: 未 init 报错、调度到对应 shards
 *   - groupByType: 4 类切片 + total
 *   - mapHits: SearchResult → Hit 字段映射
 *   - init: meta + shards fetch 流程、错误处理、幂等
 *   - handleMessage: 协议转发、unknown type
 */
import { jest } from '@jest/globals';
import MiniSearch from 'minisearch';
import {
    msOptions,
    mapHits,
    searchAllShards,
    runSearchAll,
    runSearchType,
    groupByType,
    init,
    handleMessage,
    _setEnginesForTesting,
    _resetForTesting,
} from '../worker';

// ─── 辅助：构造一个内存 MiniSearch 索引 ───
type Doc = {
    id: string;
    type: string;
    title: string;
    title_search?: string;
    author?: string;
    author_search?: string;
    aliases_search?: string;
    [k: string]: unknown;
};

function makeIndex(docs: Doc[]): MiniSearch<any> {
    const ms = new MiniSearch<any>(msOptions() as any);
    // title_search/author_search 不传时用 title/author 兜底，模拟 indexer 行为
    const prepared = docs.map(d => ({
        ...d,
        title_search: d.title_search ?? d.title,
        author_search: d.author_search ?? d.author ?? '',
        aliases_search: d.aliases_search ?? '',
    }));
    ms.addAll(prepared);
    return ms;
}

beforeEach(() => {
    _resetForTesting();
});

describe('mapHits', () => {
    it('字段映射完整：基本必填 + 可选', () => {
        const result = [{
            id: 'w1', type: 'work', title: '史記', author: '司馬遷',
            dynasty: '漢', juan_count: 130, has_text: true, score: 0.95,
        }];
        const hits = mapHits(result as any);
        expect(hits).toHaveLength(1);
        expect(hits[0]).toMatchObject({
            id: 'w1', type: 'work', title: '史記', author: '司馬遷',
            dynasty: '漢', juan_count: 130, has_text: true, score: 0.95,
        });
    });

    it('缺失可选字段返回 undefined（不抛）', () => {
        const result = [{ id: 'x', type: 'work', title: 't', score: 0 }];
        const hits = mapHits(result as any);
        expect(hits[0].author).toBeUndefined();
        expect(hits[0].dynasty).toBeUndefined();
        expect(hits[0].juan_count).toBeUndefined();
    });
});

describe('searchAllShards', () => {
    it('strict AND 命中 → 直接返回，不走 MSM', () => {
        const idx = makeIndex([
            { id: 'a', type: 'work', title: '史記', author: '司馬遷' },
            { id: 'b', type: 'work', title: '漢書', author: '班固' },
        ]);
        const hits = searchAllShards([idx], '史記');
        expect(hits.length).toBeGreaterThan(0);
        expect(hits[0].id).toBe('a');
        // 按 score desc 排
        for (let i = 1; i < hits.length; i++) {
            expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score);
        }
    });

    it('跨多个 shards 合并', () => {
        const shard1 = makeIndex([{ id: 'a', type: 'work', title: '史記' }]);
        const shard2 = makeIndex([{ id: 'b', type: 'work', title: '史記索隱' }]);
        const hits = searchAllShards([shard1, shard2], '史記');
        const ids = hits.map(h => h.id);
        expect(ids).toContain('a');
        expect(ids).toContain('b');
    });

    it('strict AND 命中含完整 query 子串的文档', () => {
        const idx = makeIndex([
            { id: 'a', type: 'work', title: '紅樓夢', title_search: '紅樓夢' },
            { id: 'b', type: 'work', title: '紅樓圓夢', title_search: '紅樓圓夢' },
            { id: 'c', type: 'work', title: '無關書', title_search: '無關書' },
        ]);
        const hits = searchAllShards([idx], '紅樓夢');
        const ids = hits.map(h => h.id);
        expect(ids).toContain('a');
        expect(ids).not.toContain('c');
    });

    it('MSM bigram 回退：strict 0 命中时，按 query bigram 命中数排序', () => {
        // query "紅樓金瓶" → bigrams [紅樓, 樓金, 金瓶]
        // 没有 doc 同时含全部 bigram；strict AND 必然 0 命中 → MSM
        const idx = makeIndex([
            { id: 'rouge',  type: 'work', title: '紅樓夢',   title_search: '紅樓夢' },   // hit 1 bigram (紅樓)
            { id: 'plum',   type: 'work', title: '金瓶梅',   title_search: '金瓶梅' },   // hit 1 bigram (金瓶)
            { id: 'noise',  type: 'work', title: '完全無關', title_search: '完全無關' },  // 0 bigram
        ]);
        const hits = searchAllShards([idx], '紅樓金瓶');
        const ids = hits.map(h => h.id);
        // MSM 应让两个分别命中 1 bigram 的文档都进入结果
        expect(ids).toContain('rouge');
        expect(ids).toContain('plum');
        expect(ids).not.toContain('noise');
    });

    it('MSM 跨片合并：同一 doc 在不同片各命中一个 bigram，hits 累加', () => {
        const shardA = makeIndex([
            { id: 'x', type: 'work', title: '紅樓夢', title_search: '紅樓某某' }, // 含 紅樓
        ]);
        const shardB = makeIndex([
            { id: 'x', type: 'work', title: '紅樓夢', title_search: '某某金瓶' }, // 同 id 含 金瓶
        ]);
        const hits = searchAllShards([shardA, shardB], '紅樓金瓶');
        const xs = hits.filter(h => h.id === 'x');
        expect(xs.length).toBeGreaterThan(0);
    });

    it('单字 query：strict 失败时不走 MSM（bigrams < 2 → 返回 []）', () => {
        const idx = makeIndex([
            { id: 'a', type: 'work', title: 'something else' },
        ]);
        // 单字 query 不在文档里，strict 0 hit，bigrams 也只有 1 个 → []
        const hits = searchAllShards([idx], '宋');
        expect(hits).toEqual([]);
    });

    it('空 shards 数组返回 []', () => {
        const hits = searchAllShards([], '史記');
        expect(hits).toEqual([]);
    });
});

describe('runSearchAll / runSearchType', () => {
    it('未 init 抛错', () => {
        expect(() => runSearchAll('史記')).toThrow(/not initialized/);
        expect(() => runSearchType('史記', 'work')).toThrow(/not initialized/);
    });

    it('空 query 返回空（不报错）', () => {
        const idx = makeIndex([{ id: 'a', type: 'work', title: '史記' }]);
        _setEnginesForTesting(new Map([['work', [idx]]]));
        expect(runSearchAll('  ').size).toBe(0);
        expect(runSearchType('  ', 'work')).toEqual([]);
    });

    it('runSearchAll 调度到所有已注册 type', () => {
        const works = makeIndex([{ id: 'w1', type: 'work', title: '史記' }]);
        const books = makeIndex([{ id: 'b1', type: 'book', title: '史記百衲本' }]);
        _setEnginesForTesting(new Map([['work', [works]], ['book', [books]]]));
        const r = runSearchAll('史記');
        expect(r.get('work')!.map(h => h.id)).toContain('w1');
        expect(r.get('book')!.map(h => h.id)).toContain('b1');
    });

    it('runSearchType 仅查指定 type', () => {
        const works = makeIndex([{ id: 'w1', type: 'work', title: '史記' }]);
        const books = makeIndex([{ id: 'b1', type: 'book', title: '史記百衲本' }]);
        _setEnginesForTesting(new Map([['work', [works]], ['book', [books]]]));
        const r = runSearchType('史記', 'book');
        expect(r.map(h => h.id)).toEqual(['b1']);
    });

    it('runSearchType 未知 type 返回 []', () => {
        const idx = makeIndex([{ id: 'a', type: 'work', title: '史記' }]);
        _setEnginesForTesting(new Map([['work', [idx]]]));
        // 强制传一个未注册的 type
        const r = runSearchType('史記', 'collection');
        expect(r).toEqual([]);
    });
});

describe('groupByType', () => {
    it('每类按 limit 切片，total 反映原始命中数', () => {
        const mk = (n: number, prefix: string) =>
            Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, type: prefix, title: `t${i}`, score: 1 - i * 0.01 } as any));
        const m = new Map<any, any>([
            ['work', mk(7, 'w')],
            ['book', mk(3, 'b')],
            ['collection', mk(0, 'c')],
            ['entity', mk(5, 'e')],
        ]);
        const g = groupByType(m, 5);
        expect(g.works).toHaveLength(5);
        expect(g.books).toHaveLength(3);
        expect(g.collections).toEqual([]);
        expect(g.entities).toHaveLength(5);
        expect(g.totalWorks).toBe(7);
        expect(g.totalBooks).toBe(3);
        expect(g.totalCollections).toBe(0);
        expect(g.totalEntities).toBe(5);
    });

    it('某 type 缺失（map 没 set）默认空数组', () => {
        const g = groupByType(new Map(), 5);
        expect(g.works).toEqual([]);
        expect(g.totalWorks).toBe(0);
    });
});

describe('init', () => {
    let originalFetch: typeof fetch;

    beforeEach(() => {
        originalFetch = global.fetch;
    });
    afterEach(() => {
        global.fetch = originalFetch;
    });

    function mockFetch(handler: (url: string) => { ok: boolean; status?: number; body?: unknown }) {
        global.fetch = jest.fn().mockImplementation((url: string) => {
            const r = handler(url);
            return Promise.resolve({
                ok: r.ok,
                status: r.status ?? 200,
                json: async () => r.body,
                text: async () => JSON.stringify(r.body),
            });
        }) as any;
    }

    it('成功加载 meta + shards', async () => {
        // 构造一个 minisearch shard 序列化
        const ms = makeIndex([{ id: 'w1', type: 'work', title: '史記' }]);
        const shardJson = JSON.parse(JSON.stringify(ms.toJSON()));

        mockFetch((url) => {
            if (url.endsWith('/meta.json')) {
                return { ok: true, body: { version: 1, indices: [{ type: 'work', file: 'core-work.json', docCount: 1 }] } };
            }
            if (url.endsWith('/core-work.json')) {
                return { ok: true, body: shardJson };
            }
            return { ok: false, status: 404 };
        });

        await init('http://test/data/search');
        // 加载完后 runSearchType 应能 work
        const hits = runSearchType('史記', 'work');
        expect(hits.length).toBeGreaterThan(0);
    });

    it('meta.json 404 → 抛错', async () => {
        mockFetch(() => ({ ok: false, status: 404 }));
        await expect(init('http://test/x')).rejects.toThrow(/meta\.json/);
    });

    it('shard 404 → 抛错', async () => {
        mockFetch((url) => {
            if (url.endsWith('/meta.json')) {
                return { ok: true, body: { version: 1, indices: [{ type: 'work', shards: ['s1.json'], docCount: 0 }] } };
            }
            return { ok: false, status: 404 };
        });
        await expect(init('http://test/x')).rejects.toThrow(/s1\.json/);
    });

    it('init 幂等（重复调用复用同一 promise）', async () => {
        const ms = makeIndex([{ id: 'a', type: 'work', title: '史記' }]);
        const shardJson = JSON.parse(JSON.stringify(ms.toJSON()));
        let metaCalls = 0;
        mockFetch((url) => {
            if (url.endsWith('/meta.json')) {
                metaCalls++;
                return { ok: true, body: { version: 1, indices: [{ type: 'work', file: 'shard.json', docCount: 1 }] } };
            }
            return { ok: true, body: shardJson };
        });

        await Promise.all([
            init('http://test/x'),
            init('http://test/x'),
            init('http://test/x'),
        ]);
        expect(metaCalls).toBe(1);
    });
});

describe('handleMessage', () => {
    it('init 消息：转发到 init() 返回 ok', async () => {
        const ms = makeIndex([{ id: 'a', type: 'work', title: '史記' }]);
        const shardJson = JSON.parse(JSON.stringify(ms.toJSON()));
        global.fetch = jest.fn().mockImplementation((url: string) => Promise.resolve({
            ok: true,
            json: async () => url.endsWith('/meta.json')
                ? { version: 1, indices: [{ type: 'work', file: 'x.json', docCount: 1 }] }
                : shardJson,
            text: async () => JSON.stringify(shardJson),
        })) as any;

        const r = await handleMessage({ id: 1, type: 'init', baseUrl: 'http://x' });
        expect(r).toEqual({ id: 1, ok: true });
    });

    it('searchAll 消息：返回分组结果', async () => {
        const works = makeIndex([{ id: 'w1', type: 'work', title: '史記' }]);
        _setEnginesForTesting(new Map([['work', [works]]]));
        const r: any = await handleMessage({ id: 7, type: 'searchAll', query: '史記', limit: 5 });
        expect(r.id).toBe(7);
        expect(r.result.works.length).toBeGreaterThan(0);
        expect(r.result.totalWorks).toBeGreaterThan(0);
    });

    it('searchEntries 消息：返回分页结果', async () => {
        // 10 个 docs，每页 3 条，第 2 页
        const docs = Array.from({ length: 10 }, (_, i) => ({
            id: `w${i}`, type: 'work', title: `史記變種${i}`, title_search: '史記',
        }));
        const works = makeIndex(docs);
        _setEnginesForTesting(new Map([['work', [works]]]));
        const r: any = await handleMessage({
            id: 9, type: 'searchEntries', query: '史記', entryType: 'work', page: 2, pageSize: 3,
        });
        expect(r.id).toBe(9);
        expect(r.result.hits).toHaveLength(3);
        expect(r.result.total).toBe(10);
        expect(r.result.page).toBe(2);
        expect(r.result.pageSize).toBe(3);
    });

    it('未知 type → throw', async () => {
        await expect(handleMessage({ id: 0, type: 'bogus' } as any)).rejects.toThrow(/unknown message type/);
    });
});
