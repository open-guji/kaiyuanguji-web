/**
 * @jest-environment node
 *
 * S1 · 搜索代理 edge-functions/api/search.js
 *
 * 盯的几件事：
 *  1) 白名单：只放行 works/books/collections/entities；其余参数（filter、sort、
 *     attributesToRetrieve……）不透传，filter 由服务端写死 is_draft = false
 *  2) limit／offset 上限、查询长度上限
 *  3) key 只在服务端（Authorization 头），响应里不带上游地址
 *  4) 60 秒短缓存：同一查询第二次不打上游
 *  5) 上游挂／超时 → 503 + code，前端据此退回 L2
 */

const g = globalThis as unknown as Record<string, unknown>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fn: any;
const realFetch = globalThis.fetch;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let calls: { url: string; init: any; body: any }[] = [];

const ENV = { MEILI_URL: 'https://meili.internal.example', MEILI_SEARCH_KEY: 'secret-search-key-123' };

function ctx(url: string, init?: RequestInit, env: Record<string, string> = ENV) {
  return { request: new Request(url, init), env };
}
async function body(res: Response) {
  return JSON.parse(await res.text());
}

/** 上游 stub：按 query 回每个索引 1 条命中，附带不该外传的字段 */
function stubUpstream(impl?: (init: RequestInit) => Promise<Response>) {
  calls = [];
  g.fetch = jest.fn(async (url: string, init: RequestInit) => {
    const parsed = JSON.parse(String(init.body));
    calls.push({ url, init, body: parsed });
    if (impl) return impl(init);
    return new Response(JSON.stringify({
      results: parsed.queries.map((q: { indexUid: string }) => ({
        indexUid: q.indexUid,
        hits: [{
          id: `${q.indexUid}-1`, type: 'work', is_draft: false, title: '史記', author: '司馬遷',
          title_search: '史記 史记', description_search: '很长的简介……', completeness: 15,
          _formatted: { id: 'x', title: '史記', description_search: '\u0001史記\u0002 簡介' },
        }],
        estimatedTotalHits: 42,
      })),
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
}

let seq = 0;
/** 缓存在 isolate 内存里跨用例存活：每个用例用不同的查询词避开 */
const uq = (s = '史記') => `${s}${++seq}`;

beforeAll(async () => {
  fn = await import('../../../../edge-functions/api/search.js');
});

afterEach(() => {
  g.fetch = realFetch;
});

describe('白名单', () => {
  test('GET 不带 index：四类索引一次 multi-search，filter 服务端写死', async () => {
    stubUpstream();
    const q = uq();
    const res = await fn.onRequestGet(ctx(`https://www.example.com/api/search?q=${encodeURIComponent(q)}&limit=5&filter=is_draft%20%3D%20true&sort=title:asc`));
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://meili.internal.example/multi-search');
    const qs = calls[0].body.queries;
    expect(qs.map((x: { indexUid: string }) => x.indexUid)).toEqual(['works', 'books', 'collections', 'entities']);
    for (const x of qs) {
      expect(x.q).toBe(q);
      expect(x.filter).toBe('is_draft = false');
      expect(x.sort).toBeUndefined();
      expect(x.attributesToRetrieve).not.toContain('description_search');
    }
    // 只有 works/books 请求简介高亮
    expect(qs[0].attributesToHighlight).toEqual(['description_search']);
    expect(qs[0].highlightPreTag).toBe('\u0001');
    expect(qs[2].attributesToHighlight).toBeUndefined();
  });

  test('不在白名单的索引 → 400，不打上游', async () => {
    stubUpstream();
    for (const idx of ['keys', 'works/../keys', 'private']) {
      const res = await fn.onRequestGet(ctx(`https://x/api/search?q=a&index=${encodeURIComponent(idx)}`));
      expect(res.status).toBe(400);
      expect((await body(res)).code).toBe('bad_request');
    }
    const res = await fn.onRequestGet(ctx('https://x/api/search?q=a&indexes=works,tasks'));
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test('POST multi-search：每条 query 过白名单，其余字段丢弃', async () => {
    stubUpstream();
    const q = uq();
    const res = await fn.onRequestPost(ctx('https://x/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queries: [
        { indexUid: 'works', q, limit: 3, filter: 'is_draft = true', attributesToRetrieve: ['*'], showRankingScore: true },
      ] }),
    }));
    expect(res.status).toBe(200);
    const sent = calls[0].body.queries[0];
    expect(sent.filter).toBe('is_draft = false');
    expect(sent.attributesToRetrieve).not.toContain('*');
    expect(sent.showRankingScore).toBeUndefined();
    expect(sent.limit).toBe(3);
  });

  test('POST 非法：非 JSON、空 queries、超过 4 条、坏索引 → 400', async () => {
    stubUpstream();
    const post = (b: string) => fn.onRequestPost(ctx('https://x/api/search', { method: 'POST', body: b }));
    expect((await post('not json')).status).toBe(400);
    expect((await post(JSON.stringify({ queries: [] }))).status).toBe(400);
    const five = Array.from({ length: 5 }, () => ({ indexUid: 'works', q: 'a' }));
    expect((await post(JSON.stringify({ queries: five }))).status).toBe(400);
    expect((await post(JSON.stringify({ queries: [{ indexUid: 'secrets', q: 'a' }] }))).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test('响应只留白名单字段，_formatted 只留简介片段', async () => {
    stubUpstream();
    const res = await fn.onRequestGet(ctx(`https://x/api/search?q=${encodeURIComponent(uq())}&index=works`));
    const data = await body(res);
    const hit = data.results[0].hits[0];
    expect(hit).toMatchObject({ id: 'works-1', title: '史記', author: '司馬遷', is_draft: false });
    expect(hit.title_search).toBeUndefined();
    expect(hit.description_search).toBeUndefined();
    expect(hit.completeness).toBeUndefined();
    expect(hit._formatted).toEqual({ description_search: '\u0001史記\u0002 簡介' });
    expect(data.results[0].estimatedTotalHits).toBe(42);
  });
});

describe('limit / offset / 长度上限', () => {
  test('limit 夹到 [1, 50]，offset 夹到 [0, 1000]', async () => {
    stubUpstream();
    await fn.onRequestGet(ctx(`https://x/api/search?q=${encodeURIComponent(uq())}&index=books&limit=100000&offset=999999`));
    expect(calls[0].body.queries[0]).toMatchObject({ limit: 50, offset: 1000 });
    await fn.onRequestGet(ctx(`https://x/api/search?q=${encodeURIComponent(uq())}&index=books&limit=-3&offset=-9`));
    expect(calls[1].body.queries[0]).toMatchObject({ limit: 1, offset: 0 });
  });

  test('默认 limit：分组 5 条，单索引 20 条', async () => {
    stubUpstream();
    await fn.onRequestGet(ctx(`https://x/api/search?q=${encodeURIComponent(uq())}`));
    expect(calls[0].body.queries.every((x: { limit: number }) => x.limit === 5)).toBe(true);
    await fn.onRequestGet(ctx(`https://x/api/search?q=${encodeURIComponent(uq())}&index=works`));
    expect(calls[1].body.queries[0].limit).toBe(20);
  });

  test('limit 非数字 → 400', async () => {
    stubUpstream();
    const res = await fn.onRequestGet(ctx('https://x/api/search?q=a&limit=abc'));
    expect(res.status).toBe(400);
  });

  test('查询超过 100 字 → 400；缺 q → 400', async () => {
    stubUpstream();
    expect((await fn.onRequestGet(ctx(`https://x/api/search?q=${encodeURIComponent('史'.repeat(101))}`))).status).toBe(400);
    expect((await fn.onRequestGet(ctx('https://x/api/search'))).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test('空查询：不打上游，直接返回空结果', async () => {
    stubUpstream();
    const res = await fn.onRequestGet(ctx('https://x/api/search?q=%20%20'));
    expect(res.status).toBe(200);
    const data = await body(res);
    expect(data.results).toHaveLength(4);
    expect(data.results.every((r: { hits: unknown[] }) => r.hits.length === 0)).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe('配置与机密', () => {
  test('key 只进上游 Authorization 头，不出现在响应里', async () => {
    stubUpstream();
    const res = await fn.onRequestGet(ctx(`https://x/api/search?q=${encodeURIComponent(uq())}`));
    expect(calls[0].init.headers.Authorization).toBe('Bearer secret-search-key-123');
    const text = await res.text();
    expect(text).not.toContain('secret-search-key-123');
    expect(text).not.toContain('meili.internal.example');
  });

  test('没配 MEILI_*：回落到 NEXT_PUBLIC_MEILI_*（全栈构建环境里有）', async () => {
    stubUpstream();
    await fn.onRequestGet(ctx(`https://x/api/search?q=${encodeURIComponent(uq())}`, undefined, {
      NEXT_PUBLIC_MEILI_URL: 'https://fallback.example/', NEXT_PUBLIC_MEILI_KEY: 'pub-key',
    }));
    expect(calls[0].url).toBe('https://fallback.example/multi-search');
    expect(calls[0].init.headers.Authorization).toBe('Bearer pub-key');
  });

  test('什么都没配：用默认地址、不带 Authorization', async () => {
    stubUpstream();
    await fn.onRequestGet(ctx(`https://x/api/search?q=${encodeURIComponent(uq())}`, undefined, {}));
    expect(calls[0].url).toBe('https://api.kaiyuanguji.com/multi-search');
    expect(calls[0].init.headers.Authorization).toBeUndefined();
  });
});

describe('短缓存', () => {
  test('同一查询 60 秒内第二次不打上游（GET 与 POST 共用）', async () => {
    stubUpstream();
    const q = uq();
    const r1 = await fn.onRequestGet(ctx(`https://x/api/search?q=${encodeURIComponent(q)}&index=works&limit=5`));
    expect(r1.headers.get('X-Search-Cache')).toBe('MISS');
    expect(r1.headers.get('Cache-Control')).toBe('public, max-age=60');
    const r2 = await fn.onRequestGet(ctx(`https://x/api/search?q=${encodeURIComponent(q)}&index=works&limit=5`));
    expect(r2.headers.get('X-Search-Cache')).toBe('HIT');
    const r3 = await fn.onRequestPost(ctx('https://x/api/search', {
      method: 'POST', body: JSON.stringify({ queries: [{ indexUid: 'works', q, limit: 5 }] }),
    }));
    expect(r3.headers.get('X-Search-Cache')).toBe('HIT');
    expect(calls).toHaveLength(1);
    expect(await body(r2)).toEqual(await body(r1));
  });

  test('60 秒后过期重新取', async () => {
    stubUpstream();
    const q = uq();
    const now = Date.now();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      await fn.onRequestGet(ctx(`https://x/api/search?q=${encodeURIComponent(q)}&index=works`));
      spy.mockReturnValue(now + 61_000);
      await fn.onRequestGet(ctx(`https://x/api/search?q=${encodeURIComponent(q)}&index=works`));
    } finally {
      spy.mockRestore();
    }
    expect(calls).toHaveLength(2);
  });
});

describe('上游故障 → 503', () => {
  test('上游 5xx：503 + upstream_unavailable，不缓存，不泄露地址', async () => {
    stubUpstream(async () => new Response('boom', { status: 502 }));
    const res = await fn.onRequestGet(ctx(`https://x/api/search?q=${encodeURIComponent(uq())}`));
    expect(res.status).toBe(503);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const data = await body(res);
    expect(data.code).toBe('upstream_unavailable');
    expect(data.error).toContain('简易搜索');
    expect(JSON.stringify(data)).not.toContain('meili.internal.example');
  });

  test('上游 401/403：code=upstream_auth', async () => {
    stubUpstream(async () => new Response('{}', { status: 403 }));
    const res = await fn.onRequestGet(ctx(`https://x/api/search?q=${encodeURIComponent(uq())}`));
    expect(res.status).toBe(503);
    expect((await body(res)).code).toBe('upstream_auth');
  });

  test('上游网络错误 → 503', async () => {
    stubUpstream(async () => { throw new TypeError('network down'); });
    const res = await fn.onRequestGet(ctx(`https://x/api/search?q=${encodeURIComponent(uq())}`));
    expect(res.status).toBe(503);
  });

  test('上游 2 秒不回 → 超时 503', async () => {
    jest.useFakeTimers();
    try {
      stubUpstream((init) => new Promise((_, reject) => {
        init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      }));
      const p = fn.onRequestGet(ctx(`https://x/api/search?q=${encodeURIComponent(uq())}`));
      await jest.advanceTimersByTimeAsync(2000);
      const res = await p;
      expect(res.status).toBe(503);
    } finally {
      jest.useRealTimers();
    }
  });

  test('失败不进缓存：恢复后同一查询能取到', async () => {
    const q = uq();
    stubUpstream(async () => new Response('boom', { status: 500 }));
    expect((await fn.onRequestGet(ctx(`https://x/api/search?q=${encodeURIComponent(q)}`))).status).toBe(503);
    stubUpstream();
    expect((await fn.onRequestGet(ctx(`https://x/api/search?q=${encodeURIComponent(q)}`))).status).toBe(200);
  });
});
