/**
 * @jest-environment node
 *
 * 12 · 错误端点串行取值致全量 110 秒 的回归闸
 *
 * 原实现为 for+await 串行 kv.get，耗时与条数成正比（实测 312 条 110s）。
 * 修复为分块并发（每批 20），此处盯三件：
 *  1) 结果正确性不受并发改动影响（过滤/排序/空值丢弃）
 *  2) 确实是并发的（耗时远小于串行）且分块限流（单批最多 20 并发）
 *  3) 边界：空列表、单条、跨批
 */

const g = globalThis as unknown as Record<string, unknown>;

/** M1：共享 token 只走 Authorization: Bearer（不再认 ?token=） */
const bearer = (t: string): RequestInit => ({ headers: { Authorization: `Bearer ${t}` } });
function ctx(url: string, init?: RequestInit) {
  return { request: new Request(url, init) };
}
async function body(res: Response) {
  return JSON.parse(await res.text());
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fn: any;

beforeAll(async () => {
  g.ERROR_VIEW_TOKEN = 'test-token';
  // 用可控延迟的 kv stub 来量并发
  fn = await import('../../../../edge-functions/api/track-error.js');
});

afterAll(() => {
  delete g.ERROR_VIEW_TOKEN;
});

/**
 * 构造带并发观测的 kv stub
 * delayMs: 每个 get 的延迟
 * store: 预置数据
 * tracker: 记录当前并发数与峰值
 */
function makeKvWithTracker(store: Map<string, string>, delayMs: number) {
  let inflight = 0;
  let peak = 0;
  let callCount = 0;
  const kv = {
    store,
    async get(k: string) {
      inflight += 1;
      callCount += 1;
      if (inflight > peak) peak = inflight;
      await new Promise((r) => setTimeout(r, delayMs));
      inflight -= 1;
      const v = store.get(k);
      return v ? JSON.parse(v) : null;
    },
    async put(k: string, v: string) {
      store.set(k, v);
    },
    async list(opts: { limit?: number; prefix?: string }) {
      const keys = [...store.keys()]
        .filter((k) => !opts.prefix || k.startsWith(opts.prefix))
        .slice(0, opts.limit ?? 50)
        .map((key) => ({ key }));
      return { keys, complete: true, cursor: '' };
    },
    _tracker() {
      return { peak: () => peak, calls: () => callCount, reset: () => { peak = 0; callCount = 0; } };
    },
  };
  return kv;
}

describe('GET /api/track-error 分块并发', () => {
  it('结果正确性：过滤与排序不受并发影响', async () => {
    const store = new Map<string, string>();
    // 预置 3 条，含不同 kind 与 createdAt
    const rows = [
      { id: 'err_1_a', kind: 'js', message: 'a', createdAt: '2026-09-10T00:00:00.000Z', state: 'open' },
      { id: 'err_2_b', kind: 'fetch', message: 'b', createdAt: '2026-09-12T00:00:00.000Z', state: 'open' },
      { id: 'err_3_c', kind: 'js', message: 'c', createdAt: '2026-09-11T00:00:00.000Z', state: 'open' },
    ];
    for (const r of rows) store.set(r.id, JSON.stringify(r));
    const kv = makeKvWithTracker(store, 2);
    (g as Record<string, unknown>).ERROR_KV = kv;

    const res = await fn.onRequestGet(ctx('https://x/api/track-error?kind=js&limit=10', bearer('test-token')));
    expect(res.status).toBe(200);
    const j = await body(res);
    // 只剩 kind=js 的两条，且按 createdAt 倒序
    expect(j.items).toHaveLength(2);
    expect(j.items[0].id).toBe('err_3_c'); // 09-11
    expect(j.items[1].id).toBe('err_1_a'); // 09-10
    expect(j.items.every((x: { kind: string }) => x.kind === 'js')).toBe(true);
  });

  it('空列表与单条不报错', async () => {
    const emptyStore = new Map<string, string>();
    (g as Record<string, unknown>).ERROR_KV = makeKvWithTracker(emptyStore, 1);
    const res0 = await fn.onRequestGet(ctx('https://x/api/track-error', bearer('test-token')));
    expect(res0.status).toBe(200);
    expect((await body(res0)).items).toHaveLength(0);

    emptyStore.set('err_1_a', JSON.stringify({ id: 'err_1_a', kind: 'js', message: 'x', createdAt: '2026-09-10T00:00:00.000Z' }));
    const kv1 = makeKvWithTracker(emptyStore, 1);
    (g as Record<string, unknown>).ERROR_KV = kv1;
    const res1 = await fn.onRequestGet(ctx('https://x/api/track-error', bearer('test-token')));
    expect((await body(res1)).items).toHaveLength(1);
  });

  it('分块并发：50 条在 20 并发分块下远快于串行，且峰值恰为 20', async () => {
    const N = 50;
    const delayMs = 20; // 若串行：50*20=1000ms；分块20并发：ceil(50/20)=3批 *20=60ms
    const store = new Map<string, string>();
    for (let i = 0; i < N; i++) {
      const id = `err_${String(i).padStart(4, '0')}_x`;
      store.set(id, JSON.stringify({ id, kind: 'js', message: `m${i}`, createdAt: `2026-09-10T00:00:00.${String(i).padStart(3, '0')}Z` }));
    }
    const kv = makeKvWithTracker(store, delayMs);
    (g as Record<string, unknown>).ERROR_KV = kv;

    const res = await fn.onRequestGet(ctx(`https://x/api/track-error?limit=${N}`, bearer('test-token')));
    expect(res.status).toBe(200);
    const j = await body(res);
    expect(j.items).toHaveLength(N);
    // 峰值并发恰为 BATCH_SIZE=20：串行时 peak===1，改成 2 也会令此断言变红
    expect(kv._tracker().peak()).toBe(20);
  });

  it('跨批边界：21 条分两批，全部返回', async () => {
    const N = 21;
    const store = new Map<string, string>();
    for (let i = 0; i < N; i++) {
      const id = `err_${String(i).padStart(4, '0')}_y`;
      store.set(id, JSON.stringify({ id, kind: 'resource', message: `m${i}`, createdAt: `2026-09-10T00:00:00.${String(i).padStart(3, '0')}Z` }));
    }
    const kv = makeKvWithTracker(store, 5);
    (g as Record<string, unknown>).ERROR_KV = kv;
    const res = await fn.onRequestGet(ctx(`https://x/api/track-error?limit=${N}`, bearer('test-token')));
    const j = await body(res);
    expect(j.items).toHaveLength(N);
  });

  it('null 值被丢弃（对应 kv.get  miss）', async () => {
    const store = new Map<string, string>();
    store.set('err_1_a', JSON.stringify({ id: 'err_1_a', kind: 'js', message: 'ok', createdAt: '2026-09-10T00:00:00.000Z' }));
    // 另一个 key 故意不放值，list 仍会返回该 key（模拟过期或删除）
    const kv = {
      store,
      async get(k: string) {
        const v = store.get(k);
        return v ? JSON.parse(v) : null;
      },
      async list() {
        return { keys: [{ key: 'err_1_a' }, { key: 'err_missing' }], complete: true, cursor: '' };
      },
    };
    (g as Record<string, unknown>).ERROR_KV = kv;
    const res = await fn.onRequestGet(ctx('https://x/api/track-error?limit=10', bearer('test-token')));
    const j = await body(res);
    expect(j.items).toHaveLength(1);
    expect(j.items[0].id).toBe('err_1_a');
  });

  it('单条 kv.get 抛错不让整页 500（allSettled 丢弃失败条）', async () => {
    const store = new Map<string, string>();
    store.set('err_1_a', JSON.stringify({ id: 'err_1_a', kind: 'js', message: 'ok', createdAt: '2026-09-10T00:00:00.000Z' }));
    store.set('err_2_b', JSON.stringify({ id: 'err_2_b', kind: 'js', message: 'ok2', createdAt: '2026-09-11T00:00:00.000Z' }));
    const kv = {
      async get(k: string) {
        if (k === 'err_2_b') throw new Error('KV throttled');
        const v = store.get(k);
        return v ? JSON.parse(v) : null;
      },
      async list() {
        return { keys: [{ key: 'err_1_a' }, { key: 'err_2_b' }], complete: true, cursor: '' };
      },
    };
    (g as Record<string, unknown>).ERROR_KV = kv;
    const res = await fn.onRequestGet(ctx('https://x/api/track-error?limit=10', bearer('test-token')));
    expect(res.status).toBe(200);
    const j = await body(res);
    expect(j.items).toHaveLength(1);
    expect(j.items[0].id).toBe('err_1_a');
  });
});
