/**
 * @jest-environment node
 */

/*
 * /api/text-progress：读只给 admin（cookie 或管理令牌），写只认管理令牌；快照整份存 KV 的 tp:snapshot。
 */
const g = globalThis as unknown as Record<string, unknown>;
g.AUTH_JWT_SECRET = 'test-jwt-secret-32bytes-long-1234567890';
g.FEEDBACK_ADMIN_TOKEN = 'test-feedback-admin';
class MockKV {
  m = new Map<string, string>();
  async put(k: string, v: string) { this.m.set(k, v); }
  async get(k: string, t?: string) { const v = this.m.get(k); if (v === undefined) return null; if (t === 'json') { try { return JSON.parse(v); } catch { return v; } } return v; }
}
const kv = new MockKV() as any;
const env: any = { AUTH_JWT_SECRET: g.AUTH_JWT_SECRET, FEEDBACK_ADMIN_TOKEN: g.FEEDBACK_ADMIN_TOKEN, AUTH_KV: kv, FEEDBACK_KV: kv };
function ctx(url: string, init: any = {}) { return { request: new Request(url, init), env }; }
async function body(r: Response) { return JSON.parse(await r.text()); }
const b64u = (s: string) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
async function sign(pl: any, secret: string) {
  const d = `${b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64u(JSON.stringify(pl))}`;
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(d)));
  let bin = ''; for (let i = 0; i < sig.length; i++) bin += String.fromCharCode(sig[i]);
  return `${d}.${b64u(bin)}`;
}

const URL_ = 'https://x/api/text-progress';
const SNAP = { schema: 'text-progress/1', generated_at: '2026-10-25T04:00:00Z', volumes: [{ book_id: '96mid1ogzk', vol: '005' }], sections: [], metrics: [] };
const post = (b: unknown, token = String(g.FEEDBACK_ADMIN_TOKEN)) => ctx(URL_, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: typeof b === 'string' ? b : JSON.stringify(b),
});

let api: any;
beforeAll(async () => { api = await import('../../../../edge-functions/api/text-progress.js'); });
beforeEach(() => { kv.m.clear(); });

describe('/api/text-progress', () => {
  it('写：管理令牌才行，存进 tp:snapshot，读回同一份', async () => {
    let r = await api.onRequestPost(post(SNAP, 'wrong'));
    expect(r.status).toBe(401);
    r = await api.onRequestPost(post(SNAP));
    expect(r.status).toBe(200);
    expect((await body(r)).bytes).toBeGreaterThan(0);
    expect(kv.m.has('tp:snapshot')).toBe(true);
    r = await api.onRequestGet(ctx(URL_, { headers: { Authorization: `Bearer ${String(g.FEEDBACK_ADMIN_TOKEN)}` } }));
    const j = await body(r);
    expect(j.success).toBe(true);
    expect(j.snapshot).toEqual(SNAP);
    expect(typeof j.stored_at).toBe('string');
  });

  it('写：形状不对拒绝', async () => {
    expect((await api.onRequestPost(post('not json'))).status).toBe(400);
    expect((await api.onRequestPost(post({ ...SNAP, schema: 'x' }))).status).toBe(400);
    expect((await api.onRequestPost(post({ ...SNAP, volumes: [{ vol: '1' }] }))).status).toBe(400);
    expect((await api.onRequestPost(post({ ...SNAP, metrics: {} }))).status).toBe(400);
    expect(kv.m.size).toBe(0);
  });

  it('读：只给 admin；没有快照时 snapshot 为 null', async () => {
    const now = Math.floor(Date.now() / 1000);
    await kv.put('member:a@x.com', JSON.stringify({ role: 'admin', joinedAt: now, tokenVersion: 1 }));
    await kv.put('member:e@x.com', JSON.stringify({ role: 'editor', joinedAt: now, tokenVersion: 1 }));
    const admin = await sign({ sub: 'a@x.com', tv: 1, iat: now, exp: now + 3600 }, String(g.AUTH_JWT_SECRET));
    const editor = await sign({ sub: 'e@x.com', tv: 1, iat: now, exp: now + 3600 }, String(g.AUTH_JWT_SECRET));
    let r = await api.onRequestGet(ctx(URL_, { headers: { Cookie: `session=${admin}` } }));
    expect(r.status).toBe(200);
    expect(await body(r)).toEqual({ success: true, snapshot: null });
    r = await api.onRequestGet(ctx(URL_, { headers: { Cookie: `session=${editor}` } }));
    expect(r.status).toBe(401);
    r = await api.onRequestGet(ctx(URL_));
    expect(r.status).toBe(401);
  });

  it('成员 cookie 不能写', async () => {
    const now = Math.floor(Date.now() / 1000);
    await kv.put('member:a@x.com', JSON.stringify({ role: 'admin', joinedAt: now, tokenVersion: 1 }));
    const admin = await sign({ sub: 'a@x.com', tv: 1, iat: now, exp: now + 3600 }, String(g.AUTH_JWT_SECRET));
    const r = await api.onRequestPost(ctx(URL_, { method: 'POST', headers: { Cookie: `session=${admin}` }, body: JSON.stringify(SNAP) }));
    expect(r.status).toBe(401);
    expect(kv.m.has('tp:snapshot')).toBe(false);
  });

  it('校验函数', () => {
    expect(api.validateSnapshot(SNAP)).toBeNull();
    expect(api.validateSnapshot([])).toMatch(/对象/);
  });
});
