/**
 * @jest-environment node
 *
 * 搜索代理的后端开关（Postgres 迁移）：meili（默认）｜pg｜shadow，见 edge-functions/api/search.js 头部说明。
 */
const g = globalThis as unknown as Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fn: any;
const realFetch = globalThis.fetch;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let calls: { url: string; init: any; body: any }[] = [];

const BASE = { MEILI_URL: 'https://meili.internal.example', MEILI_SEARCH_KEY: 'meili-key' };
const PG = { SEARCH_PG_URL: 'https://pg.internal.example:7710', SEARCH_PG_KEY: 'pg-key' };

function ctx(url: string, env: Record<string, string>, waits?: Promise<unknown>[]) {
  return { request: new Request(url), env, ...(waits ? { waitUntil: (p: Promise<unknown>) => { waits.push(p); } } : {}) };
}

function hitsFor(tag: string) {
  return (q: { indexUid: string }) => ({
    indexUid: q.indexUid,
    hits: [{ id: `${tag}-${q.indexUid}`, type: 'work', title: '史記', author: '司馬遷' }],
    estimatedTotalHits: 1,
    processingTimeMs: 3,
  });
}

/** meili／pg 两个上游：按 URL 分流；pgFail 时 PG 回 503；开关文件由 switchBackend 决定 */
function stub(opts: { pgFail?: boolean; switchBackend?: string } = {}) {
  calls = [];
  g.fetch = jest.fn(async (url: string, init: RequestInit) => {
    if (url.includes('switch.json')) {
      calls.push({ url, init, body: null });
      return new Response(JSON.stringify({ backend: opts.switchBackend }), { status: 200 });
    }
    const parsed = JSON.parse(String(init.body));
    calls.push({ url, init, body: parsed });
    if (url.startsWith('https://pg.')) {
      if (opts.pgFail) return new Response('{}', { status: 503 });
      return new Response(JSON.stringify({ results: parsed.queries.map(hitsFor('pg')) }), { status: 200 });
    }
    return new Response(JSON.stringify({ results: parsed.queries.map(hitsFor('meili')) }), { status: 200 });
  });
}

let seq = 0;
const uq = (s = '史記') => `${s}${++seq}`;
const url = (q: string, extra = '') => `https://x.example/api/search?index=works&q=${encodeURIComponent(q)}${extra}`;

beforeAll(async () => {
  fn = await import('../../../../edge-functions/api/search.js');
});
afterEach(() => {
  g.fetch = realFetch;
});

describe('后端开关', () => {
  test('没配 SEARCH_PG_URL：永远走 Meili，也不读开关文件', async () => {
    stub({ switchBackend: 'pg' });
    const res = await fn.onRequestGet(ctx(url(uq()), BASE));
    expect(res.headers.get('X-Search-Backend')).toBe('meili');
    expect(calls.every((c) => c.url.startsWith('https://meili.'))).toBe(true);
  });

  test('SEARCH_BACKEND=pg：打 search-api，带 Bearer、filter 是 clause 列表、sort 原样，结果形状不变', async () => {
    stub();
    const q = uq();
    const res = await fn.onRequestGet(ctx(url(q, '&filter=dynasty%20%3D%20%22%E6%98%8E%22&sort=era:asc'), { ...BASE, ...PG, SEARCH_BACKEND: 'pg' }));
    expect(res.headers.get('X-Search-Backend')).toBe('pg');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://pg.internal.example:7710/multi-search');
    expect(calls[0].init.headers.Authorization).toBe('Bearer pg-key');
    const sent = calls[0].body.queries[0];
    expect(sent.q).toBe(q);
    expect(sent.filter).toEqual([{ field: 'dynasty', op: 'eq', values: ['明'] }]);
    expect(sent.sort).toBe('era_rank:asc');
    expect(JSON.stringify(sent)).not.toContain('is_draft');
    const out = JSON.parse(await res.text());
    expect(out.results[0].hits[0].id).toBe('pg-works');
    expect(out.results[0].estimatedTotalHits).toBe(1);
  });

  test('pg 失败：当场回落 Meili，结果照常', async () => {
    stub({ pgFail: true });
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const res = await fn.onRequestGet(ctx(url(uq()), { ...BASE, ...PG, SEARCH_BACKEND: 'pg' }));
    spy.mockRestore();
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.url.split('/multi-search')[0])).toEqual(['https://pg.internal.example:7710', 'https://meili.internal.example']);
    expect(JSON.parse(await res.text()).results[0].hits[0].id).toBe('meili-works');
  });

  test('shadow：返回 Meili 结果，后台再打一次 PG 比对并只写日志', async () => {
    stub();
    const waits: Promise<unknown>[] = [];
    const rnd = jest.spyOn(Math, 'random').mockReturnValue(0);
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const res = await fn.onRequestGet(ctx(url(uq()), { ...BASE, ...PG, SEARCH_BACKEND: 'shadow' }, waits));
    await Promise.all(waits);
    const logged = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes('"shadow"'));
    rnd.mockRestore();
    log.mockRestore();
    expect(JSON.parse(await res.text()).results[0].hits[0].id).toBe('meili-works');
    expect(calls.some((c) => c.url.startsWith('https://pg.'))).toBe(true);
    expect(JSON.parse(String(logged))).toMatchObject({ shadow: 'ok' });
  });

  test('开关文件：读到 backend=pg 就走 PG；之后 TTL 内不再读', async () => {
    stub({ switchBackend: 'pg' });
    const r1 = await fn.onRequestGet(ctx(url(uq()), { ...BASE, ...PG }));
    expect(r1.headers.get('X-Search-Backend')).toBe('pg');
    const r2 = await fn.onRequestGet(ctx(url(uq()), { ...BASE, ...PG }));
    expect(r2.headers.get('X-Search-Backend')).toBe('pg');
    expect(calls.filter((c) => c.url.includes('switch.json'))).toHaveLength(1);
  });
});
