/**
 * @jest-environment node
 *
 * 全文搜索代理 edge-functions/api/fulltext.js（照 search-proxy.test.ts 的路子：经 onRequestGet 走全链路、mock 全局 fetch）。
 *
 * 盯的几件事：
 *  1) 开关：开关文件（COS JSON）isolate 缓存、读失败沿用上次、从没读到当关；FULLTEXT_ENABLED=0 硬关；没配源站当关；
 *     关时搜索 503 disabled、no-store、不打上游；op=status 短缓存
 *  2) 白名单与校验：不合法 400 不打上游；只转发白名单参数；q 截到 61 码点
 *  3) 上游：带 X-FT-Token；4xx/5xx JSON 透传；401/403/404 与网络错 → 503 upstream；超时 → 504 timeout；响应不带源站与令牌
 *  4) 限流 30/分（按 request.eo.clientIp）→ 429 rate_limited
 *  5) 缓存：同一查询第二次 HIT、不打上游；浏览器 max-age=60
 */

const g = globalThis as unknown as Record<string, unknown>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fn: any;
const realFetch = globalThis.fetch;

const ORIGIN = 'http://10.9.8.7:8765';
const TOKEN = 'ft-secret-token-xyz';
let switchSeq = 0;
/** 每个用例一个新的开关地址：开关状态缓存在 isolate 里，换地址即重置 */
const newSwitchUrl = () => `https://switch.example.com/fulltext/switch-${++switchSeq}.json`;

let env: Record<string, string>;
let switchUrl: string;
let switchBody: unknown;
let switchStatus: number;
let switchCalls: number;
let upstreamCalls: { url: string; headers: Record<string, string> }[];
let upstreamImpl: (url: string) => Promise<Response>;

const SAMPLE = { q: '學而', mode: 'fuzzy', normalized: '学而', truncated: false, total_hits: 1, groups: [] };
const ok = (obj: unknown = SAMPLE) => new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } });

function install() {
  g.fetch = jest.fn(async (url: string, init: RequestInit = {}) => {
    if (url === switchUrl) {
      switchCalls++;
      if (switchStatus === -1) throw new TypeError('network');
      return new Response(typeof switchBody === 'string' ? switchBody : JSON.stringify(switchBody), { status: switchStatus });
    }
    upstreamCalls.push({ url, headers: { ...(init.headers as Record<string, string>) } });
    return upstreamImpl(url);
  });
}

beforeAll(async () => {
  fn = await import('../../../../edge-functions/api/fulltext.js');
});

let ipSeq = 0;
let ip: string;
beforeEach(() => {
  switchUrl = newSwitchUrl();
  env = { FULLTEXT_ORIGIN: ORIGIN, FULLTEXT_TOKEN: TOKEN, FULLTEXT_SWITCH_URL: switchUrl };
  switchBody = { enabled: true, reason: '', updatedAt: '2026-10-19T10:00:00-07:00', by: 'x' };
  switchStatus = 200;
  switchCalls = 0;
  upstreamCalls = [];
  upstreamImpl = async () => ok();
  ip = `203.0.113.${++ipSeq}`;
  install();
});

afterEach(() => {
  g.fetch = realFetch;
  jest.useRealTimers();
});

let qSeq = 0;
/** 结果缓存跨用例存活：每次用不同的查询词 */
const uq = (s = '學而') => `${s}${++qSeq}`;

function get(qs: string, extra: Record<string, unknown> = {}) {
  const request = new Request(`https://www.example.com/api/fulltext?${qs}`);
  (request as unknown as { eo: unknown }).eo = { clientIp: ip };
  return fn.onRequestGet({ request, env, ...extra });
}
const search = (q = uq(), more = '') => get(`q=${encodeURIComponent(q)}${more}`);
async function body(res: Response) {
  return JSON.parse(await res.text());
}

describe('op=status', () => {
  test('开关开 → enabled:true，短缓存', async () => {
    const res = await get('op=status');
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ enabled: true });
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=30');
    expect(upstreamCalls).toHaveLength(0);
  });

  test('开关文件关 → enabled:false 带 reason', async () => {
    switchBody = { enabled: false, reason: '搜索机维护', updatedAt: 'x', by: 'y' };
    expect(await body(await get('op=status'))).toEqual({ enabled: false, reason: '搜索机维护' });
  });

  test('FULLTEXT_ENABLED=0 硬关，压过开关文件，也不去读开关文件', async () => {
    env.FULLTEXT_ENABLED = '0';
    expect(await body(await get('op=status'))).toMatchObject({ enabled: false, reason: 'disabled_by_env' });
    expect(switchCalls).toBe(0);
  });

  test('没配 FULLTEXT_ORIGIN 当关', async () => {
    delete env.FULLTEXT_ORIGIN;
    expect(await body(await get('op=status'))).toMatchObject({ enabled: false, reason: 'not_configured' });
  });

  test('开关文件从没读到过（网络错／非 200／坏 JSON／enabled 非布尔）→ 当关', async () => {
    for (const [st, b] of [[-1, {}], [404, {}], [200, 'not json'], [200, { enabled: 'yes' }]] as const) {
      switchUrl = newSwitchUrl();
      env.FULLTEXT_SWITCH_URL = switchUrl;
      switchStatus = st;
      switchBody = b;
      expect(await body(await get('op=status'))).toMatchObject({ enabled: false, reason: 'switch_unavailable' });
    }
  });

  test('不认识的 op → 400', async () => {
    expect((await get('op=reload')).status).toBe(400);
  });

  test('响应里不出现源站地址与令牌', async () => {
    const text = await (await get('op=status')).text();
    expect(text).not.toContain('10.9.8.7');
    expect(text).not.toContain(TOKEN);
  });
});

describe('开关缓存', () => {
  test('30 秒内只读一次开关文件；过期后重读，读失败沿用上次的值', async () => {
    jest.useFakeTimers({ doNotFake: ['performance', 'queueMicrotask', 'nextTick', 'setImmediate'] });
    jest.setSystemTime(new Date('2026-10-19T10:00:00-07:00'));
    await get('op=status');
    await get('op=status');
    expect(switchCalls).toBe(1);

    jest.setSystemTime(new Date('2026-10-19T10:00:31-07:00'));
    switchStatus = -1; // 读失败
    expect(await body(await get('op=status'))).toEqual({ enabled: true });
    expect(switchCalls).toBe(2);

    // 失败后 10 秒再试；这回关了
    jest.setSystemTime(new Date('2026-10-19T10:00:42-07:00'));
    switchStatus = 200;
    switchBody = { enabled: false, reason: '关一下' };
    expect(await body(await get('op=status'))).toEqual({ enabled: false, reason: '关一下' });
    expect(switchCalls).toBe(3);
  });
});

describe('关时的搜索', () => {
  test('开关文件关 → 503 disabled、no-store、不打上游', async () => {
    switchBody = { enabled: false };
    const res = await search();
    expect(res.status).toBe(503);
    expect(await body(res)).toEqual({ error: 'disabled' });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(upstreamCalls).toHaveLength(0);
  });

  test('硬关时连已缓存的结果也不给', async () => {
    const q = uq();
    expect((await search(q)).status).toBe(200);
    env.FULLTEXT_ENABLED = '0';
    const res = await search(q);
    expect(res.status).toBe(503);
    expect(await body(res)).toEqual({ error: 'disabled' });
  });
});

describe('白名单与校验', () => {
  test.each([
    ['', '空 q'],
    ['q=%20%20', '只有空白'],
    ['q=a&mode=regex', 'mode'],
    ['q=a&group=chapter', 'group'],
    ['q=a&limit=0', 'limit 下限'],
    ['q=a&limit=51', 'limit 上限'],
    ['q=a&limit=1.5', 'limit 非整数'],
    ['q=a&offset=-1', 'offset 下限'],
    ['q=a&offset=10001', 'offset 上限'],
    ['q=a&per_book=21', 'per_book 上限'],
    ['q=a&entry=../x', 'entry 非字母数字'],
  ])('%s（%s）→ 400 bad_query，不打上游', async (qs) => {
    const res = await get(qs);
    expect(res.status).toBe(400);
    expect((await body(res)).error).toBe('bad_query');
    expect(upstreamCalls).toHaveLength(0);
  });

  test('只转发白名单参数（补默认值），带 X-FT-Token', async () => {
    const q = uq();
    const res = await search(q, '&mode=exact&limit=20&offset=40&per_book=5&entry=d59df01avcw0&evil=1&token=x');
    expect(res.status).toBe(200);
    expect(upstreamCalls).toHaveLength(1);
    const u = new URL(upstreamCalls[0].url);
    expect(u.origin + u.pathname).toBe(`${ORIGIN}/api/fulltext`);
    expect(Object.fromEntries(u.searchParams)).toEqual({
      q, mode: 'exact', group: 'book', limit: '20', offset: '40', per_book: '5', entry: 'd59df01avcw0',
    });
    expect(upstreamCalls[0].headers['X-FT-Token']).toBe(TOKEN);
  });

  test('mode=near（差一字）放行', async () => {
    const q = uq('學而時習');
    expect((await search(q, '&mode=near')).status).toBe(200);
    expect(new URL(upstreamCalls[0].url).searchParams.get('mode')).toBe('near');
  });

  test('q 截到 61 个码点（含扩展区字），超长判定交给上游', async () => {
    const long = '𠀀'.repeat(30) + '學'.repeat(50) + uq();
    await search(long);
    const sent = new URL(upstreamCalls[0].url).searchParams.get('q')!;
    expect(Array.from(sent)).toHaveLength(61);
    expect(sent.startsWith('𠀀'.repeat(30))).toBe(true);
  });
});

describe('上游', () => {
  test('成功：200，MISS，浏览器 max-age=60；第二次 HIT 不打上游', async () => {
    const q = uq();
    const r1 = await search(q);
    expect(r1.status).toBe(200);
    expect(r1.headers.get('X-Fulltext-Cache')).toBe('MISS');
    expect(r1.headers.get('Cache-Control')).toBe('public, max-age=60');
    expect(await body(r1)).toEqual(SAMPLE);
    const r2 = await search(q);
    expect(r2.headers.get('X-Fulltext-Cache')).toBe('HIT');
    expect(await body(r2)).toEqual(SAMPLE);
    expect(upstreamCalls).toHaveLength(1);
    expect(r2.headers.get('Server-Timing')).toMatch(/total;dur=/);
  });

  test('边缘 Cache API：成功结果写入 caches.default；内存没有时从那里取（HIT，不打上游）', async () => {
    const store = new Map<string, string>();
    g.caches = {
      default: {
        match: async (req: Request) => (store.has(req.url) ? new Response(store.get(req.url)) : undefined),
        put: async (req: Request, res: Response) => { store.set(req.url, await res.text()); },
      },
    };
    try {
      const q = uq();
      await search(q);
      expect(store.size).toBe(1);
      const [k, v] = [...store.entries()][0];
      expect(k).not.toContain(TOKEN);
      expect(JSON.parse(v)).toMatchObject({ body: JSON.stringify(SAMPLE) });

      // 别的 isolate 写进边缘缓存的条目（本 isolate 内存里没有）
      const q2 = uq();
      const key = new URLSearchParams({ q: q2, mode: 'fuzzy', group: 'book', limit: '10', offset: '0', per_book: '3' }).toString();
      const cached = { ...SAMPLE, q: q2 };
      store.set(`https://fulltext-cache.invalid/v1?${key}`, JSON.stringify({ t: Date.now(), body: JSON.stringify(cached) }));
      const res = await search(q2);
      expect(res.headers.get('X-Fulltext-Cache')).toBe('HIT');
      expect(await body(res)).toEqual(cached);
      expect(upstreamCalls).toHaveLength(1);
    } finally {
      delete g.caches;
    }
  });

  test('上游 4xx/5xx 带 JSON：原样透传状态码与 JSON，不缓存，Retry-After 透传', async () => {
    upstreamImpl = async () => new Response(JSON.stringify({ error: 'busy' }), { status: 503, headers: { 'Retry-After': '3' } });
    const q = uq();
    const res = await search(q);
    expect(res.status).toBe(503);
    expect(await body(res)).toEqual({ error: 'busy' });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Retry-After')).toBe('3');
    upstreamImpl = async () => new Response(JSON.stringify({ error: 'bad_query', message: 'x' }), { status: 400 });
    const r2 = await search(q);
    expect(r2.status).toBe(400);
    expect(upstreamCalls).toHaveLength(2);
  });

  test.each([401, 403, 404])('上游 %d（令牌／地址配错）→ 503 upstream', async (st) => {
    upstreamImpl = async () => new Response('not found', { status: st });
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const res = await search();
    spy.mockRestore();
    expect(res.status).toBe(503);
    expect(await body(res)).toEqual({ error: 'upstream' });
  });

  test('网络错 → 503 upstream；不带源站地址', async () => {
    upstreamImpl = async () => { throw new TypeError(`connect ECONNREFUSED ${ORIGIN}`); };
    const res = await search();
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'upstream' });
    expect(text).not.toContain('10.9.8.7');
  });

  test('超时（5 秒）→ 504 timeout', async () => {
    jest.useFakeTimers({ doNotFake: ['performance', 'queueMicrotask', 'nextTick', 'setImmediate', 'Date'] });
    upstreamImpl = (url) => new Promise((_, reject) => {
      void url;
      // 等 abort
      const sig = (g.fetch as jest.Mock).mock.calls.at(-1)[1].signal as AbortSignal;
      sig.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
    const p = search();
    await jest.advanceTimersByTimeAsync(5001);
    const res = await p;
    expect(res.status).toBe(504);
    expect(await body(res)).toEqual({ error: 'timeout' });
  });

  test('上游 200 但不是 JSON → 503 upstream', async () => {
    upstreamImpl = async () => new Response('<html>', { status: 200 });
    const res = await search();
    expect(res.status).toBe(503);
  });
});

describe('限流', () => {
  test('同一 IP 每分钟 30 次，第 31 次 429 + Retry-After；换 IP 不受影响', async () => {
    jest.useFakeTimers({ doNotFake: ['performance', 'queueMicrotask', 'nextTick', 'setImmediate'] });
    jest.setSystemTime(new Date('2026-10-19T10:00:05-07:00'));
    const q = uq();
    for (let i = 0; i < 30; i++) expect((await search(q)).status).toBe(200);
    const res = await search(q);
    expect(res.status).toBe(429);
    expect(await body(res)).toEqual({ error: 'rate_limited' });
    expect(Number(res.headers.get('Retry-After'))).toBe(55);
    ip = '198.51.100.1';
    expect((await search(q)).status).toBe(200);
    // 下一分钟恢复
    ip = `203.0.113.${ipSeq}`;
    jest.setSystemTime(new Date('2026-10-19T10:01:00-07:00'));
    expect((await search(q)).status).toBe(200);
  });

  test('status 不计入限流', async () => {
    for (let i = 0; i < 40; i++) await get('op=status');
    expect((await search()).status).toBe(200);
  });
});
