/**
 * @jest-environment node
 *
 * 错误自收端点的鉴权闸。
 *
 * 为什么值得为一个边缘函数单写一个测试：2026-09-14 实测发现它的两处鉴权都写作
 * `if (token && given !== token)`，线上 ERROR_VIEW_TOKEN 从未配置，于是整段跳过——
 * 312 条含访客 IP 的记录公开可读了四个月，**期间没有任何东西报警**。
 * fail-open 的特征就是「坏了和好了长得一模一样」，只能靠闸挡。
 *
 * 这里盯死三件：没配变量要拒、token 不对要拒、?debug=eo 不能绕过这道闸。
 */

// 边缘函数在 EdgeOne 里靠全局变量拿 KV 与环境变量，测试里照样注入全局。
const g = globalThis as unknown as Record<string, unknown>;

const kvStub = {
  store: new Map<string, string>(),
  async get(k: string) {
    const v = this.store.get(k);
    return v ? JSON.parse(v) : null;
  },
  async put(k: string, v: string) {
    this.store.set(k, v);
  },
  async list() {
    return { keys: [...this.store.keys()].map((key) => ({ key })), complete: true, cursor: '' };
  },
};

function ctx(url: string, init?: RequestInit) {
  return { request: new Request(url, init) };
}

async function body(res: Response) {
  return JSON.parse(await res.text());
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fn: any;

beforeAll(async () => {
  g.ERROR_KV = kvStub;
  fn = await import('../../../../edge-functions/api/track-error.js');
});

beforeEach(() => {
  kvStub.store.clear();
  kvStub.store.set(
    'err_1_a',
    JSON.stringify({ id: 'err_1_a', kind: 'js', message: 'x', clientIp: '1.2.3.4', state: 'open' }),
  );
});

afterEach(() => {
  delete g.ERROR_VIEW_TOKEN;
});

describe('GET /api/track-error 鉴权', () => {
  it('没配 ERROR_VIEW_TOKEN 时一律拒绝，而不是放行', async () => {
    const res = await fn.onRequestGet(ctx('https://x/api/track-error?limit=10'));
    expect(res.status).toBe(503);
    const j = await body(res);
    expect(j.success).toBe(false);
    // 关键：响应里不能夹带任何一条记录
    expect(j.items).toBeUndefined();
  });

  it('没配 ERROR_VIEW_TOKEN 时，带上任意 token 也不放行', async () => {
    const res = await fn.onRequestGet(ctx('https://x/api/track-error?token=whatever'));
    expect(res.status).toBe(503);
  });

  it('配了变量、token 不对 → 401', async () => {
    g.ERROR_VIEW_TOKEN = 'right-token';
    const res = await fn.onRequestGet(ctx('https://x/api/track-error?token=wrong'));
    expect(res.status).toBe(401);
    expect((await body(res)).items).toBeUndefined();
  });

  it('配了变量、不带 token → 401', async () => {
    g.ERROR_VIEW_TOKEN = 'right-token';
    const res = await fn.onRequestGet(ctx('https://x/api/track-error'));
    expect(res.status).toBe(401);
  });

  it('token 对 → 正常返回记录', async () => {
    g.ERROR_VIEW_TOKEN = 'right-token';
    const res = await fn.onRequestGet(ctx('https://x/api/track-error?token=right-token'));
    expect(res.status).toBe(200);
    const j = await body(res);
    expect(j.success).toBe(true);
    expect(j.items).toHaveLength(1);
  });

  it('?debug=eo 绕不过这道闸（它会回 request.eo 与全部请求头）', async () => {
    const res = await fn.onRequestGet(ctx('https://x/api/track-error?debug=eo'));
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain('headers');
  });
});

describe('POST action=update 鉴权', () => {
  const post = (b: unknown) =>
    ctx('https://x/api/track-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(b),
    });

  it('没配变量时不能改记录状态', async () => {
    const res = await fn.onRequestPost(post({ action: 'update', id: 'err_1_a', state: 'resolved' }));
    expect(res.status).toBe(503);
    expect(JSON.parse(kvStub.store.get('err_1_a')!).state).toBe('open');
  });

  it('配了变量、token 不对 → 401 且记录不动', async () => {
    g.ERROR_VIEW_TOKEN = 'right-token';
    const res = await fn.onRequestPost(
      post({ action: 'update', id: 'err_1_a', state: 'resolved', token: 'wrong' }),
    );
    expect(res.status).toBe(401);
    expect(JSON.parse(kvStub.store.get('err_1_a')!).state).toBe('open');
  });

  it('token 对 → 改得动', async () => {
    g.ERROR_VIEW_TOKEN = 'right-token';
    const res = await fn.onRequestPost(
      post({ action: 'update', id: 'err_1_a', state: 'resolved', token: 'right-token' }),
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(kvStub.store.get('err_1_a')!).state).toBe('resolved');
  });
});

describe('POST 上报（公开）不受影响', () => {
  it('不带 token 也能上报——前端必须能匿名调', async () => {
    const res = await fn.onRequestPost(
      ctx('https://x/api/track-error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'js', message: '匿名上报' }),
      }),
    );
    expect(res.status).toBe(200);
    expect((await body(res)).success).toBe(true);
  });
});
