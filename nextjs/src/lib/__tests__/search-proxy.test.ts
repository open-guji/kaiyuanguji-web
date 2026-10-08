/**
 * @jest-environment node
 *
 * S1 · 搜索代理 edge-functions/api/search.js
 *
 * 盯的几件事：
 *  1) 白名单：只放行 works/books/collections/entities；其余参数（attributesToRetrieve……）不透传；
 *     sort 只认 era／title 的 asc／desc 四个键（overview#298），见 describe('sort')，is_draft = false 由服务端写死；
 *     filter 只放行受限语法（见 describe('filter')，overview#291 P1a）
 *  2) limit／offset 上限、查询长度上限
 *  3) key 只在服务端（Authorization 头），响应里不带上游地址
 *  4) 缓存：10 分钟新鲜、24 小时内先给旧的后台刷新（overview#353），见 describe('缓存')
 *  5) 上游挂／超时 → 503 + code，前端据此退回 L2；有旧结果时先给旧的
 *  6) Server-Timing：parse／cache／upstream／meili／total（overview#353）
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
    const res = await fn.onRequestGet(ctx(`https://www.example.com/api/search?q=${encodeURIComponent(q)}&limit=5`));
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
        { indexUid: 'works', q, limit: 3, attributesToRetrieve: ['*'], showRankingScore: true },
      ] }),
    }));
    expect(res.status).toBe(200);
    const sent = calls[0].body.queries[0];
    expect(sent.filter).toBe('is_draft = false');
    expect(sent.attributesToRetrieve).not.toContain('*');
    expect(sent.showRankingScore).toBeUndefined();
    expect(sent.sort).toBeUndefined();
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

describe('缓存（overview#353）', () => {
  const url = (q: string) => `https://x/api/search?q=${encodeURIComponent(q)}&index=works&limit=5`;

  test('同一查询新鲜期内第二次不打上游（GET 与 POST 共用）', async () => {
    stubUpstream();
    const q = uq();
    const r1 = await fn.onRequestGet(ctx(url(q)));
    expect(r1.headers.get('X-Search-Cache')).toBe('MISS');
    expect(r1.headers.get('Cache-Control')).toBe('public, max-age=300');
    const r2 = await fn.onRequestGet(ctx(url(q)));
    expect(r2.headers.get('X-Search-Cache')).toBe('HIT');
    const r3 = await fn.onRequestPost(ctx('https://x/api/search', {
      method: 'POST', body: JSON.stringify({ queries: [{ indexUid: 'works', q, limit: 5 }] }),
    }));
    expect(r3.headers.get('X-Search-Cache')).toBe('HIT');
    expect(calls).toHaveLength(1);
    expect(await body(r2)).toEqual(await body(r1));
  });

  test('9 分钟仍新鲜；过了 10 分钟、平台没有 waitUntil：同步重取', async () => {
    stubUpstream();
    const q = uq();
    const now = Date.now();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      await fn.onRequestGet(ctx(url(q)));
      spy.mockReturnValue(now + 9 * 60_000);
      expect((await fn.onRequestGet(ctx(url(q)))).headers.get('X-Search-Cache')).toBe('HIT');
      spy.mockReturnValue(now + 10 * 60_000 + 1000);
      expect((await fn.onRequestGet(ctx(url(q)))).headers.get('X-Search-Cache')).toBe('MISS');
    } finally {
      spy.mockRestore();
    }
    expect(calls).toHaveLength(2);
  });

  test('过了 10 分钟、有 waitUntil：先回旧结果（STALE），后台重取，再来就是新的', async () => {
    stubUpstream();
    const q = uq();
    const now = Date.now();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
    const pending: Promise<unknown>[] = [];
    const withWait = () => ({ ...ctx(url(q)), waitUntil: (p: Promise<unknown>) => { pending.push(p); } });
    try {
      await fn.onRequestGet(withWait());
      await Promise.all(pending.splice(0));
      spy.mockReturnValue(now + 11 * 60_000);
      const r = await fn.onRequestGet(withWait());
      expect(r.headers.get('X-Search-Cache')).toBe('STALE');
      expect(r.status).toBe(200);
      await Promise.all(pending.splice(0));
      expect(calls).toHaveLength(2);
      const r2 = await fn.onRequestGet(withWait());
      expect(r2.headers.get('X-Search-Cache')).toBe('HIT');
      expect(calls).toHaveLength(2);
    } finally {
      spy.mockRestore();
    }
  });

  test('超过 24 小时：旧结果作废，同步重取', async () => {
    stubUpstream();
    const q = uq();
    const now = Date.now();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      await fn.onRequestGet(ctx(url(q)));
      spy.mockReturnValue(now + 24 * 3600_000 + 1000);
      const r = await fn.onRequestGet({ ...ctx(url(q)), waitUntil: () => {} });
      expect(r.headers.get('X-Search-Cache')).toBe('MISS');
    } finally {
      spy.mockRestore();
    }
    expect(calls).toHaveLength(2);
  });

  test('上游挂了但有 24 小时内的旧结果：200 + STALE，不退回简易搜索', async () => {
    stubUpstream();
    const q = uq();
    const now = Date.now();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const r1 = await fn.onRequestGet(ctx(url(q)));
      stubUpstream(async () => new Response('boom', { status: 502 }));
      spy.mockReturnValue(now + 2 * 3600_000);
      const r2 = await fn.onRequestGet(ctx(url(q)));
      expect(r2.status).toBe(200);
      expect(r2.headers.get('X-Search-Cache')).toBe('STALE');
      expect(await body(r2)).toEqual(await body(r1));
    } finally {
      spy.mockRestore();
    }
  });

  test('同一查询并发：只打一次上游', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    stubUpstream(async (init) => {
      await gate;
      const parsed = JSON.parse(String(init.body));
      return new Response(JSON.stringify({
        results: parsed.queries.map((x: { indexUid: string }) => ({ indexUid: x.indexUid, hits: [], estimatedTotalHits: 0 })),
      }), { status: 200 });
    });
    const q = uq();
    const ps = [1, 2, 3].map(() => fn.onRequestGet(ctx(url(q))));
    release();
    const rs = await Promise.all(ps);
    expect(rs.map((r: Response) => r.status)).toEqual([200, 200, 200]);
    expect(calls).toHaveLength(1);
  });
});

describe('Server-Timing（overview#353）', () => {
  const metrics = (res: Response) => Object.fromEntries((res.headers.get('Server-Timing') || '').split(',').map((m) => {
    const [name, ...params] = m.trim().split(';');
    const dur = params.find((x) => x.startsWith('dur='));
    return [name, dur ? Number(dur.slice(4)) : NaN];
  }));

  test('MISS：parse／cache／upstream／meili／total 都有，meili 取各索引 processingTimeMs 的最大值', async () => {
    stubUpstream(async (init) => {
      const parsed = JSON.parse(String(init.body));
      return new Response(JSON.stringify({
        results: parsed.queries.map((x: { indexUid: string }, i: number) => ({ indexUid: x.indexUid, hits: [], estimatedTotalHits: 0, processingTimeMs: 3 + i * 4 })),
      }), { status: 200 });
    });
    const res = await fn.onRequestGet(ctx(`https://x/api/search?q=${encodeURIComponent(uq())}`));
    const m = metrics(res);
    for (const k of ['parse', 'cache', 'upstream', 'meili', 'total']) expect(Number.isFinite(m[k])).toBe(true);
    expect(m.meili).toBe(15);
    expect(res.headers.get('Server-Timing')).toContain('upstream;desc="1"');
  });

  test('HIT：没有 upstream；503 也带 Server-Timing', async () => {
    stubUpstream();
    const q = uq();
    await fn.onRequestGet(ctx(`https://x/api/search?q=${encodeURIComponent(q)}`));
    const hit = metrics(await fn.onRequestGet(ctx(`https://x/api/search?q=${encodeURIComponent(q)}`)));
    expect(hit.upstream).toBeUndefined();
    expect(Number.isFinite(hit.total)).toBe(true);
    stubUpstream(async () => new Response('boom', { status: 502 }));
    const bad = await fn.onRequestGet(ctx(`https://x/api/search?q=${encodeURIComponent(uq())}`));
    expect(bad.status).toBe(503);
    expect(metrics(bad).upstream).toBeGreaterThanOrEqual(0);
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

describe('filter（overview#291 P1a）', () => {
  const get = (q: string, filter: string | null, index = 'works') =>
    fn.onRequestGet(ctx(`https://x/api/search?q=${encodeURIComponent(q)}&index=${index}${filter === null ? '' : `&filter=${encodeURIComponent(filter)}`}`));
  const post = (query: Record<string, unknown>) =>
    fn.onRequestPost(ctx('https://x/api/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ queries: [query] }) }));
  const sentFilter = () => calls[0].body.queries[0].filter as string;

  test('不带 filter：只有 is_draft = false（与之前一致）', async () => {
    stubUpstream();
    expect((await get(uq(), null)).status).toBe(200);
    expect(sentFilter()).toBe('is_draft = false');
    stubUpstream();
    expect((await get(uq(), '')).status).toBe(200);
    expect(sentFilter()).toBe('is_draft = false');
  });

  test('朝代＋部类组合：is_draft = false 在最前，其余按 AST 重新拼', async () => {
    stubUpstream();
    const res = await get(uq(), 'dynasty IN ["唐","宋"] AND classification = "史部"');
    expect(res.status).toBe(200);
    expect(sentFilter()).toBe('is_draft = false AND dynasty IN ["唐", "宋"] AND classification = "史部"');
  });

  test('布尔字段、存佚多选', async () => {
    stubUpstream();
    expect((await get(uq(), 'has_image = true AND has_text = false AND loss_status IN ["extant","partially_extant","lost"]')).status).toBe(200);
    expect(sentFilter()).toBe('is_draft = false AND has_image = true AND has_text = false AND loss_status IN ["extant", "partially_extant", "lost"]');
  });

  test('空串值（未分類）改写成 Meili 的 IS EMPTY：`= ""` 在 Meili 里筛不到空值', async () => {
    stubUpstream();
    expect((await get(uq(), 'classification = ""')).status).toBe(200);
    expect(sentFilter()).toBe('is_draft = false AND classification IS EMPTY');
    stubUpstream();
    expect((await get(uq(), 'classification IN [""]')).status).toBe(200);
    expect(sentFilter()).toBe('is_draft = false AND classification IS EMPTY');
    // 多选里带空串：其余值 OR IS EMPTY，括号包住，不影响后面的 AND
    stubUpstream();
    expect((await get(uq(), 'classification IN ["史部","", "經部"] AND dynasty = "唐"')).status).toBe(200);
    expect(sentFilter()).toBe('is_draft = false AND (classification IN ["史部", "經部"] OR classification IS EMPTY) AND dynasty = "唐"');
    stubUpstream();
    expect((await get(uq(), 'classification IN ["史部",""]')).status).toBe(200);
    expect(sentFilter()).toBe('is_draft = false AND (classification IN ["史部"] OR classification IS EMPTY)');
  });

  test('规整：关键字大小写、空白不影响，发给上游的是重新拼的串（不含原串）', async () => {
    stubUpstream();
    const res = await get(uq(), '  dynasty   in  [ "明" ]\n and   HAS_TEXT=TRUE'.replace('HAS_TEXT', 'has_text'));
    expect(res.status).toBe(200);
    expect(sentFilter()).toBe('is_draft = false AND dynasty IN ["明"] AND has_text = true');
  });

  test('POST 里的 filter 同样过校验，其余字段照旧丢弃', async () => {
    stubUpstream();
    const res = await post({ indexUid: 'works', q: uq(), filter: 'classification = "經部"', showRankingScore: true });
    expect(res.status).toBe(200);
    const sent = calls[0].body.queries[0];
    expect(sent.filter).toBe('is_draft = false AND classification = "經部"');
    expect(sent.sort).toBeUndefined();
    expect(sent.showRankingScore).toBeUndefined();
  });

  test('同一 q 不同 filter 不共用缓存；相同 filter（含 GET／POST）共用', async () => {
    stubUpstream();
    const q = uq();
    await get(q, 'dynasty = "唐"');
    await get(q, 'dynasty = "宋"');
    expect(calls).toHaveLength(2);
    await get(q, 'dynasty  =  "唐"');
    await post({ indexUid: 'works', q, limit: 20, filter: 'dynasty = "唐"' }); // GET 单索引默认 20 条
    expect(calls).toHaveLength(2);
  });

  test('多索引请求：filter 对每个索引各自校验，某个索引不支持的字段 → 400', async () => {
    stubUpstream();
    // has_collated 只有 works 有
    const bad = await fn.onRequestGet(ctx(`https://x/api/search?q=a&indexes=works,books&filter=${encodeURIComponent('has_collated = true')}`));
    expect(bad.status).toBe(400);
    const ok = await fn.onRequestGet(ctx(`https://x/api/search?q=${uq()}&indexes=works,books&filter=${encodeURIComponent('dynasty = "唐"')}`));
    expect(ok.status).toBe(200);
    expect(calls[0].body.queries.map((x: { filter: string }) => x.filter)).toEqual(['is_draft = false AND dynasty = "唐"', 'is_draft = false AND dynasty = "唐"']);
  });

  const rejected: [string, string, string?][] = [
    ['is_draft 不许碰（绕过只搜正式条目）', 'is_draft = true'],
    ['is_draft 用 IN 也不行', 'is_draft IN ["true"]'],
    ['不在白名单的字段', 'holder = "某"'],
    ['字段名带路径', 'a.b = "c"'],
    ['books 没有 classification', 'classification = "史部"', 'books'],
    ['entities 没有 has_image', 'has_image = true', 'entities'],
    ['collections 只有 type', 'dynasty = "唐"', 'collections'],
    ['OR 不支持', 'dynasty = "唐" OR dynasty = "宋"'],
    ['括号不支持', '(dynasty = "唐")'],
    ['NOT 不支持', 'NOT dynasty = "唐"'],
    ['!= 不支持', 'dynasty != "唐"'],
    ['字符串没引号', 'dynasty = 唐'],
    ['单引号', "dynasty = '唐'"],
    ['字符串字段等于 true', 'dynasty = true'],
    ['布尔字段等于字符串', 'has_image = "true"'],
    ['布尔字段用 IN', 'has_image IN [true]'],
    ['IN 后不是数组', 'dynasty IN "唐"'],
    ['IN 数组没闭合', 'dynasty IN ["唐"'],
    ['IN 空数组', 'dynasty IN []'],
    ['引号没闭合', 'dynasty = "唐'],
    ['值里有反斜杠', 'dynasty = "唐\\"'],
    ['值里有控制字符', 'dynasty = "唐\u0001"'],
    ['注入：值里塞引号和 OR', 'dynasty = "唐" OR is_draft = true OR dynasty = "x"'],
    ['同一字段两次', 'dynasty = "唐" AND dynasty = "宋"'],
    ['只有字段名', 'dynasty'],
    ['结尾多余 AND', 'dynasty = "唐" AND'],
    ['乱码', '@@@'],
  ];
  test.each(rejected)('非法：%s → 400，不打上游', async (_name, filter, index = 'works') => {
    stubUpstream();
    const res = await get(uq(), filter, index);
    expect(res.status).toBe(400);
    expect((await body(res)).code).toBe('bad_request');
    expect(calls).toHaveLength(0);
  });

  test('非法：POST 里 filter 不是字符串（数组、对象）→ 400', async () => {
    stubUpstream();
    expect((await post({ indexUid: 'works', q: 'a', filter: ['dynasty = "唐"'] })).status).toBe(400);
    expect((await post({ indexUid: 'works', q: 'a', filter: { dynasty: '唐' } })).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test('超长：整串超过上限、值超过上限、条数过多、IN 值过多 → 400', async () => {
    stubUpstream();
    const many = (n: number) => Array.from({ length: n }, (_, i) => `"甲${i}"`).join(',');
    expect((await get('a', `dynasty IN [${many(30)}] AND ${'x'.repeat(700)}`)).status).toBe(400);
    expect((await get('a', `dynasty = "${'唐'.repeat(21)}"`)).status).toBe(400);
    expect((await get('a', 'dynasty = "唐" AND classification = "史部" AND loss_status = "lost" AND has_image = true AND has_text = true AND has_collated = true AND type = "work"')).status).toBe(400); // 7 条
    expect((await get('a', `dynasty IN [${many(41)}]`)).status).toBe(400);
    expect(calls).toHaveLength(0);
    // 边界内可以：6 条、40 个值（朝代分组展开后的量）、20 字
    expect((await get(uq(), 'dynasty = "唐" AND classification = "史部" AND loss_status = "lost" AND has_image = true AND has_text = true AND has_collated = true')).status).toBe(200);
    expect((await get(uq(), `dynasty IN [${many(40)}]`)).status).toBe(200);
    expect((await get(uq(), `dynasty = "${'唐'.repeat(20)}"`)).status).toBe(200);
  });

  test('命中里带 classification／loss_status（表格的「部类」列），不在白名单的字段仍不外传', async () => {
    stubUpstream(async (init) => {
      const parsed = JSON.parse(String(init.body));
      return new Response(JSON.stringify({
        results: parsed.queries.map((q: { indexUid: string }) => ({
          indexUid: q.indexUid,
          hits: [{ id: 'w1', type: 'work', title: '史記', classification: '史部', loss_status: 'extant', title_search: '史記 史记', completeness: 9 }],
          estimatedTotalHits: 1,
        })),
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const res = await get(uq(), 'classification = "史部"');
    const hit = (await body(res)).results[0].hits[0];
    expect(hit.classification).toBe('史部');
    expect(hit.loss_status).toBe('extant');
    expect(hit.title_search).toBeUndefined();
    expect(hit.completeness).toBeUndefined();
  });
});

describe('sort（搜索页 v4「按年代／按书名」，overview#298）', () => {
  const post = (query: object) => fn.onRequestPost(ctx('https://x/api/search', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ queries: [query] }),
  }));
  const getSort = (sort: string, index = 'works') =>
    fn.onRequestGet(ctx(`https://x/api/search?q=${encodeURIComponent(uq())}&index=${index}&sort=${encodeURIComponent(sort)}`));

  test('四个键翻译成索引里的可排序字段，发给 Meili 的 sort 是数组', async () => {
    const want: Record<string, string> = {
      'era:asc': 'era_rank:asc', 'era:desc': 'era_rank:desc', 'title:asc': 'title_sort:asc', 'title:desc': 'title_sort:desc',
    };
    for (const [k, v] of Object.entries(want)) {
      stubUpstream();
      expect((await getSort(k)).status).toBe(200);
      expect(calls[0].body.queries[0].sort).toEqual([v]);
    }
  });

  test('works／books／entities 可排；collections 不可（没有这两个字段）→ 400', async () => {
    stubUpstream();
    for (const idx of ['works', 'books', 'entities']) expect((await getSort('era:asc', idx)).status).toBe(200);
    expect((await getSort('era:asc', 'collections')).status).toBe(400);
    expect((await getSort('era:asc', 'collections').then((r: Response) => body(r))).code).toBe('bad_request');
  });

  test('不认识的键、数组、Meili 语法一律 400，不打上游；POST 里同样', async () => {
    stubUpstream();
    for (const bad of ['completeness:desc', 'era_rank:asc', 'era', 'title:sideways', '_geoPoint(1,2):asc']) expect((await getSort(bad)).status).toBe(400);
    expect((await post({ indexUid: 'works', q: uq(), sort: ['era:asc'] })).status).toBe(400);
    expect(calls).toHaveLength(0);
    expect((await post({ indexUid: 'works', q: uq(), sort: 'era:desc' })).status).toBe(200);
    expect(calls[0].body.queries[0].sort).toEqual(['era_rank:desc']);
  });

  test('同一查询不同 sort 不共用缓存', async () => {
    stubUpstream();
    const q = uq();
    const url = (s: string) => `https://x/api/search?q=${encodeURIComponent(q)}&index=works&sort=${s}`;
    await fn.onRequestGet(ctx(url('era:asc')));
    await fn.onRequestGet(ctx(url('era:desc')));
    await fn.onRequestGet(ctx(url('era:asc')));
    expect(calls).toHaveLength(2);
  });

  test('索引还没重建出可排序字段（Meili 回 400＋invalid_search_sort）：去掉 sort 重发一次，按相关度出结果并标 sortIgnored', async () => {
    let n = 0;
    stubUpstream(async (init) => {
      const parsed = JSON.parse(String(init.body));
      n++;
      if (parsed.queries.some((q: { sort?: string[] }) => q.sort)) return new Response('{"code":"invalid_search_sort","message":"x"}', { status: 400 });
      return new Response(JSON.stringify({ results: parsed.queries.map((q: { indexUid: string }) => ({ indexUid: q.indexUid, hits: [], estimatedTotalHits: 0 })) }), { status: 200 });
    });
    const res = await getSort('title:asc');
    expect(res.status).toBe(200);
    expect(n).toBe(2);
    expect(calls[1].body.queries[0].sort).toBeUndefined();
    expect((await body(res)).results[0].sortIgnored).toBe(true);
  });

  test('别的 400（错误码不是排序类、或没有错误码）不降级：照常 503，不重发', async () => {
    for (const upstream of ['{"code":"invalid_search_filter","message":"x"}', 'not json', '{}']) {
      let n = 0;
      stubUpstream(async () => { n++; return new Response(upstream, { status: 400 }); });
      const res = await getSort('era:asc');
      expect(res.status).toBe(503);
      expect(n).toBe(1);
    }
  });

  test('降级结果不缓存：同一查询再来一次仍打上游（重建索引后不会 一段时间内还拿到未排序的）；响应 no-store', async () => {
    let n = 0;
    stubUpstream(async (init) => {
      const parsed = JSON.parse(String(init.body));
      n++;
      if (parsed.queries.some((q: { sort?: string[] }) => q.sort)) return new Response('{"code":"invalid_search_sort"}', { status: 400 });
      return new Response(JSON.stringify({ results: parsed.queries.map((q: { indexUid: string }) => ({ indexUid: q.indexUid, hits: [], estimatedTotalHits: 0 })) }), { status: 200 });
    });
    const q = uq();
    const url = `https://x/api/search?q=${encodeURIComponent(q)}&index=works&sort=era:asc`;
    const r1 = await fn.onRequestGet(ctx(url));
    expect(r1.headers.get('Cache-Control')).toBe('no-store');
    await fn.onRequestGet(ctx(url));
    expect(n).toBe(4); // 每次都是「带 sort 一次 + 去掉 sort 一次」
  });
});

describe('locale（首页检索候选跟繁简走，overview#342）', () => {
    const url = (q: string, extra = '') => `https://www.example.com/api/search?q=${encodeURIComponent(q)}&limit=5${extra}`;

    test('locale=zh-Hans：书名、作者转简体（opencc t2cn），筛选取值与简介片段不动；上游请求不变', async () => {
        stubUpstream();
        const q = uq('武職');
        const res = await fn.onRequestGet(ctx(url(q, '&locale=zh-Hans')));
        expect(res.status).toBe(200);
        const hit = (await body(res)).results[0].hits[0];
        expect(hit.title).toBe('史记');
        expect(hit.author).toBe('司马迁');
        expect(hit._formatted.description_search).toBe('\u0001史記\u0002 簡介');
        // locale 不进上游请求
        expect(calls[0].body.queries[0]).not.toHaveProperty('locale');
        expect(calls[0].body.queries[0].q).toBe(q);
    });

    test('locale=zh-Hans：异体字先归一再转（寳→宝、㫖→旨，overview#350）；zh-Hant 原样', async () => {
        const variantHit = () => new Response(JSON.stringify({
            results: [{
                indexUid: 'works', estimatedTotalHits: 1,
                hits: [{ id: 'v1', type: 'work', is_draft: false, title: '風月寳鑑', author: '㫖縂', _formatted: { id: 'v1', title: '風月寳鑑' } }],
            }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        stubUpstream(async () => variantHit());
        const hans = (await body(await fn.onRequestGet(ctx(url(uq('寳'), '&locale=zh-Hans'))))).results[0].hits[0];
        expect(hans.title).toBe('风月宝鉴');
        expect(hans.author).toBe('旨总');
        stubUpstream(async () => variantHit());
        const hant = (await body(await fn.onRequestGet(ctx(url(uq('寳'), '&locale=zh-Hant'))))).results[0].hits[0];
        expect(hant.title).toBe('風月寳鑑');
    });

    test('locale=zh-Hans：「著」不转成「着」（opencc t 预设，与组件库同口径，overview#368）', async () => {
        stubUpstream(async () => new Response(JSON.stringify({
            results: [{
                indexUid: 'works', estimatedTotalHits: 1,
                hits: [{ id: 'z1', type: 'work', is_draft: false, title: '四庫全書總目著録', author: '紀昀編著', _formatted: { id: 'z1', title: '四庫全書總目著録' } }],
            }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        const hit = (await body(await fn.onRequestGet(ctx(url(uq('著録'), '&locale=zh-Hans'))))).results[0].hits[0];
        expect(hit.title).toBe('四库全书总目著录');
        expect(hit.author).toBe('纪昀编著');
    });

    test('不传 locale 或 zh-Hant：原样（结果页 L1 不传，行为不变）', async () => {
        for (const extra of ['', '&locale=zh-Hant']) {
            stubUpstream();
            const res = await fn.onRequestGet(ctx(url(uq(), extra)));
            const hit = (await body(res)).results[0].hits[0];
            expect(hit.title).toBe('史記');
            expect(hit.author).toBe('司馬遷');
        }
    });

    test('缓存键带 locale：同一查询先繁后简，各打一次上游、各回各的字', async () => {
        stubUpstream();
        const q = uq();
        const a = await body(await fn.onRequestGet(ctx(url(q))));
        const b = await body(await fn.onRequestGet(ctx(url(q, '&locale=zh-Hans'))));
        const c = await fn.onRequestGet(ctx(url(q, '&locale=zh-Hans')));
        expect(a.results[0].hits[0].title).toBe('史記');
        expect(b.results[0].hits[0].title).toBe('史记');
        expect(c.headers.get('X-Search-Cache')).toBe('HIT');
        expect((await body(c)).results[0].hits[0].title).toBe('史记');
        expect(calls).toHaveLength(2);
    });

    test('POST 体里的 locale 同样生效；不认识的 locale 一律 400', async () => {
        stubUpstream();
        const res = await fn.onRequestPost(ctx('https://www.example.com/api/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ locale: 'zh-Hans', queries: [{ indexUid: 'works', q: uq(), limit: 5 }] }),
        }));
        expect((await body(res)).results[0].hits[0].title).toBe('史记');

        stubUpstream();
        const bad = await fn.onRequestGet(ctx(url(uq(), '&locale=en')));
        expect(bad.status).toBe(400);
        expect((await body(bad)).code).toBe('bad_request');
        expect(calls).toHaveLength(0);
    });
});

describe('响应压缩（overview#487：函数出的响应 EdgeOne 不压，函数自己压 gzip）', () => {
  /** 上游回很多命中，让响应体超过 1 KB 的压缩门槛 */
  function stubBigUpstream() {
    stubUpstream(async (init) => {
      const parsed = JSON.parse(String(init.body));
      return new Response(JSON.stringify({
        results: parsed.queries.map((q: { indexUid: string }) => ({
          indexUid: q.indexUid,
          hits: Array.from({ length: 30 }, (_, i) => ({
            id: `${q.indexUid}-${i}`, type: 'work', is_draft: false, title: `史記${i}`, author: '司馬遷', dynasty: '西漢',
          })),
          estimatedTotalHits: 300,
        })),
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
  }
  const get = (q: string, headers: Record<string, string> = {}) =>
    fn.onRequestGet(ctx(`https://www.example.com/api/search?q=${encodeURIComponent(q)}&limit=30`, { headers }));
  async function gunzip(res: Response): Promise<string> {
    const stream = new Response(res.body).body!.pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).text();
  }

  test('接受 gzip 且响应体够大：gzip 压缩，带 Content-Encoding／Vary，Content-Length 是压后的长度，解开与未压缩一致', async () => {
    stubBigUpstream();
    const q = uq();
    const plain = await get(q);
    const plainText = await plain.text();
    expect(plain.headers.get('Content-Encoding')).toBeNull();
    expect(Buffer.byteLength(plainText)).toBeGreaterThan(1024);

    const res = await get(q, { 'Accept-Encoding': 'gzip, br' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Encoding')).toBe('gzip');
    expect(res.headers.get('Vary')).toMatch(/Accept-Encoding/i);
    expect(res.headers.get('Content-Type')).toMatch(/application\/json/);
    expect(res.headers.get('X-Search-Cache')).toBe('HIT'); // 其余响应头原样保留
    const clone = res.clone();
    const raw = new Uint8Array(await clone.arrayBuffer());
    expect(Number(res.headers.get('Content-Length'))).toBe(raw.byteLength);
    expect(raw.byteLength).toBeLessThan(Buffer.byteLength(plainText) / 2);
    expect(await gunzip(res)).toBe(plainText);
  });

  test('没带 Accept-Encoding、只接受 br、gzip;q=0：不压，但都带 Vary: Accept-Encoding（缓存按编码分别存）', async () => {
    stubBigUpstream();
    const q = uq();
    for (const h of [{}, { 'Accept-Encoding': 'br' }, { 'Accept-Encoding': 'gzip;q=0, br' }, { 'Accept-Encoding': 'identity' }]) {
      const res = await get(q, h);
      expect(res.headers.get('Content-Encoding')).toBeNull();
      expect(res.headers.get('Vary')).toMatch(/Accept-Encoding/i);
      expect(JSON.parse(await res.text()).results).toHaveLength(4);
    }
  });

  test('Accept-Encoding: *;q=1 算接受；响应体不到 1 KB 不压', async () => {
    stubBigUpstream();
    const star = await get(uq(), { 'Accept-Encoding': '*' });
    expect(star.headers.get('Content-Encoding')).toBe('gzip');

    stubUpstream();
    const small = await get(uq(), { 'Accept-Encoding': 'gzip' });
    expect(small.headers.get('Content-Encoding')).toBeNull();
    expect(small.headers.get('Vary')).toMatch(/Accept-Encoding/i);
  });

  test('错误响应（400）也带 Vary；POST 同样压缩', async () => {
    stubBigUpstream();
    const bad = await fn.onRequestGet(ctx('https://www.example.com/api/search?q=x&index=nope', { headers: { 'Accept-Encoding': 'gzip' } }));
    expect(bad.status).toBe(400);
    expect(bad.headers.get('Vary')).toMatch(/Accept-Encoding/i);

    const q = uq();
    const res = await fn.onRequestPost(ctx('https://www.example.com/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'gzip' },
      body: JSON.stringify({ queries: [{ indexUid: 'works', q, limit: 30 }] }),
    }));
    expect(res.headers.get('Content-Encoding')).toBe('gzip');
    expect(JSON.parse(await gunzip(res)).results).toHaveLength(1);
  });

  test('运行时没有 CompressionStream：原样返回未压缩（不让搜索失败）', async () => {
    stubBigUpstream();
    const saved = g.CompressionStream;
    delete g.CompressionStream;
    try {
      const res = await get(uq(), { 'Accept-Encoding': 'gzip' });
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Encoding')).toBeNull();
      expect(JSON.parse(await res.text()).results).toHaveLength(4);
    } finally {
      g.CompressionStream = saved;
    }
  });
});
