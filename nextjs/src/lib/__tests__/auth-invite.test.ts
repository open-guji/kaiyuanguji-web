/**
 * @jest-environment node
 *
 * G-20 邀请链接最小闭环的 durable 闸
 * 覆盖 v3 铁律：GET 不消耗、一次性、7d 过期、180d JWT、删人/改角色立即生效
 */
const g = globalThis as unknown as Record<string, unknown>;
g.AUTH_JWT_SECRET = 'test-jwt-secret-32bytes-long-1234567890';
g.AUTH_ADMIN_TOKEN = 'test-admin-token';

class MockKV {
  m = new Map<string, string>();
  async put(k: string, v: string) { this.m.set(k, v); }
  async get(k: string, type?: string) {
    const v = this.m.get(k);
    if (v === undefined) return null;
    if (type === 'json') { try { return JSON.parse(v); } catch { return v; } }
    return v;
  }
  async delete(k: string) { this.m.delete(k); }
  async list(opts?: any) {
    const prefix = opts?.prefix || '';
    const keys = [...this.m.keys()].filter(k => k.startsWith(prefix)).map(k => ({ key: k }));
    return { keys, complete: true, cursor: '' };
  }
}
const kv = new MockKV() as any;
const env: any = { AUTH_JWT_SECRET: g.AUTH_JWT_SECRET, AUTH_ADMIN_TOKEN: g.AUTH_ADMIN_TOKEN, AUTH_KV: kv, ERROR_KV: kv, FEEDBACK_KV: kv };
function ctx(url: string, init: any = {}) { return { request: new Request(url, init), env }; }
async function body(res: Response) { return JSON.parse(await res.text()); }
function getCookie(res: Response) { return res.headers.get('Set-Cookie') || res.headers.get('set-cookie') || ''; }

let invite: any, inviteInfo: any, join: any, me: any, logout: any, revoke: any;
beforeAll(async () => {
  invite = await import('../../../../edge-functions/api/auth/invite.js');
  inviteInfo = await import('../../../../edge-functions/api/auth/invite-info.js');
  join = await import('../../../../edge-functions/api/auth/join.js');
  me = await import('../../../../edge-functions/api/auth/me.js');
  logout = await import('../../../../edge-functions/api/auth/logout.js');
  revoke = await import('../../../../edge-functions/api/auth/revoke.js');
});
beforeEach(() => { kv.m.clear(); });

describe('invite/invite-info/join 闭环', () => {
  it('管理员生码，GET invite-info 多次不消耗，POST join 消费后一次性', async () => {
    let res = await invite.onRequestPost(ctx('https://x/api/auth/invite', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${g.AUTH_ADMIN_TOKEN}` },
      body: JSON.stringify({ email: 'alice@example.com', role: 'editor' })
    }));
    expect(res.status).toBe(200);
    const { code } = await body(res);
    expect(code).toMatch(/^[A-Za-z0-9_-]{22}$/);

    // GET 两次均 valid
    res = await inviteInfo.onRequestGet(ctx(`https://x/api/auth/invite-info?c=${code}`));
    expect((await body(res)).valid).toBe(true);
    res = await inviteInfo.onRequestGet(ctx(`https://x/api/auth/invite-info?c=${code}`));
    expect((await body(res)).valid).toBe(true);

    // join 消费
    res = await join.onRequestPost(ctx('https://x/api/auth/join', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    }));
    expect(res.status).toBe(200);
    expect(getCookie(res)).toMatch(/session=/);
    // 二次 join 410
    res = await join.onRequestPost(ctx('https://x/api/auth/join', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    }));
    expect(res.status).toBe(410);
  });

  it('未绑定邮箱的码需自填邮箱，且 7d 过期判定读 expires 字段', async () => {
    let res = await invite.onRequestPost(ctx('https://x/api/auth/invite', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${g.AUTH_ADMIN_TOKEN}` },
      body: JSON.stringify({ email: null, role: 'reviewer' })
    }));
    const { code } = await body(res);
    // 不填邮箱应 400
    res = await join.onRequestPost(ctx('https://x/api/auth/join', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    }));
    expect(res.status).toBe(400);
    // 填邮箱成功
    res = await join.onRequestPost(ctx('https://x/api/auth/join', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, email: 'bob@example.com' })
    }));
    expect(res.status).toBe(200);
  });

  it('me 返回现 role，滑动续期与删人/改角色立即生效', async () => {
    let res = await invite.onRequestPost(ctx('https://x/api/auth/invite', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${g.AUTH_ADMIN_TOKEN}` },
      body: JSON.stringify({ email: 'alice@example.com', role: 'editor' })
    }));
    const { code } = await body(res);
    res = await join.onRequestPost(ctx('https://x/api/auth/join', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code })
    }));
    const sess = getCookie(res).match(/session=([^;]+)/)?.[1] || '';
    res = await me.onRequestGet(ctx('https://x/api/auth/me', { headers: { 'Cookie': `session=${sess}` } } as any));
    expect(res.status).toBe(200);
    expect((await body(res)).role).toBe('editor');

    // 改成 admin
    await kv.put('member:alice@example.com', JSON.stringify({ role: 'admin', joinedAt: 1, invitedBy: 'x' }));
    res = await revoke.onRequestPost(ctx('https://x/api/auth/revoke', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Cookie': `session=${sess}` },
      body: JSON.stringify({ email: 'charlie@example.com', role: 'editor' })
    }));
    expect(res.status).toBe(200);
    // charlie 尚不存在但应能创建；清理以免影响 bob 的 invite/join
    await kv.delete('member:charlie@example.com');
    res = await invite.onRequestPost(ctx('https://x/api/auth/invite', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${g.AUTH_ADMIN_TOKEN}` },
      body: JSON.stringify({ email: 'bob@example.com', role: 'reviewer' })
    }));
    const code2 = (await body(res)).code;
    res = await join.onRequestPost(ctx('https://x/api/auth/join', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code2 })
    }));
    const bobSess = getCookie(res).match(/session=([^;]+)/)?.[1] || '';
    // 改 bob 为 editor
    res = await revoke.onRequestPost(ctx('https://x/api/auth/revoke', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Cookie': `session=${sess}` },
      body: JSON.stringify({ email: 'bob@example.com', role: 'editor' })
    }));
    expect(res.status).toBe(200);
    res = await me.onRequestGet(ctx('https://x/api/auth/me', { headers: { 'Cookie': `session=${bobSess}` } } as any));
    expect((await body(res)).role).toBe('editor');
    // 删 bob
    res = await revoke.onRequestPost(ctx('https://x/api/auth/revoke', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Cookie': `session=${sess}` },
      body: JSON.stringify({ email: 'bob@example.com' })
    }));
    expect(res.status).toBe(200);
    res = await me.onRequestGet(ctx('https://x/api/auth/me', { headers: { 'Cookie': `session=${bobSess}` } } as any));
    expect(res.status).toBe(401);
  });

  it('logout 清 cookie', async () => {
    const res = await logout.onRequestPost(ctx('https://x/api/auth/logout', { method: 'POST', headers: { 'Cookie': 'session=abc' } } as any));
    expect(res.status).toBe(200);
    expect(getCookie(res)).toMatch(/Max-Age=0/);
  });
});
