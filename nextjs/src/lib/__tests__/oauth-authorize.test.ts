/**
 * @jest-environment node
 *
 * OA-授权端点 /oauth/authorize 的完成判据（任务书 §二·1）：
 * 未登录页面提示、prompt=none→login_required、已登录→302 带 code/state、
 * redirect_uri 不在白名单→400、缺配置→503。
 */

class MockKV {
  m = new Map<string, string>();
  async put(k: string, v: string) { this.m.set(k, v); }
  async get(k: string, type?: string) {
    const v = this.m.get(k);
    if (v === undefined) return null;
    if (type === 'json') { try { return JSON.parse(v); } catch { return null; } }
    return v;
  }
  async delete(k: string) { this.m.delete(k); }
}

const JWT_SECRET = 'test-jwt-secret-32bytes-long-1234567890';
const CLIENT_ID = 'collate';
const CLIENT_SECRET = 'test-client-secret';
const REDIRECT_URI = 'https://collate.example.com/callback';

function b64url(bytes: Uint8Array) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return Buffer.from(bin, 'binary').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
async function sha256Hex(str: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function signJWT(payload: Record<string, unknown>, secret: string) {
  const enc = new TextEncoder();
  const h = b64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const p = b64url(enc.encode(JSON.stringify(payload)));
  const data = `${h}.${p}`;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return `${data}.${b64url(new Uint8Array(sig))}`;
}
async function sessionCookieFor(email: string) {
  const now = Math.floor(Date.now() / 1000);
  const token = await signJWT({ sub: email, iat: now, exp: now + 3600 }, JWT_SECRET);
  return `session=${token}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fn: any;
let kv: MockKV;

async function baseEnv() {
  return {
    AUTH_JWT_SECRET: JWT_SECRET,
    AUTH_KV: kv,
    OAUTH_CLIENTS: JSON.stringify({
      [CLIENT_ID]: { secret_hash: await sha256Hex(CLIENT_SECRET), redirect_uris: [REDIRECT_URI] },
    }),
  };
}

function authorizeUrl(overrides: Record<string, string> = {}) {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    state: 'xyz',
    code_challenge: 'abc123',
    code_challenge_method: 'S256',
    ...overrides,
  });
  return `https://www.kaiyuanguji.com/oauth/authorize?${params.toString()}`;
}
function ctx(url: string, env: Record<string, unknown>, cookie?: string) {
  const headers: Record<string, string> = {};
  if (cookie) headers['Cookie'] = cookie;
  return { request: new Request(url, { headers }), env };
}

beforeAll(async () => {
  fn = await import('../../../../edge-functions/oauth/authorize.js');
});
beforeEach(() => { kv = new MockKV(); });

describe('未登录', () => {
  it('无 session cookie，无 prompt=none → 302 到 /oauth/login-required 带 return_to', async () => {
    const env = await baseEnv();
    const res = await fn.onRequestGet(ctx(authorizeUrl(), env));
    expect(res.status).toBe(302);
    const loc = res.headers.get('Location') || '';
    expect(loc).toContain('/oauth/login-required?');
    const returnTo = new URL(loc).searchParams.get('return_to') || '';
    expect(returnTo.startsWith('/oauth/authorize?')).toBe(true);
    expect(returnTo).toContain(`client_id=${CLIENT_ID}`);
  });

  it('无 session cookie，prompt=none → 302 回 redirect_uri?error=login_required', async () => {
    const env = await baseEnv();
    const res = await fn.onRequestGet(ctx(authorizeUrl({ prompt: 'none' }), env));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('Location') || '');
    expect(loc.origin + loc.pathname).toBe(REDIRECT_URI);
    expect(loc.searchParams.get('error')).toBe('login_required');
    expect(loc.searchParams.get('state')).toBe('xyz');
  });

  it('session cookie 签名不对，等价于未登录 → 302 到 login-required', async () => {
    const env = await baseEnv();
    const res = await fn.onRequestGet(ctx(authorizeUrl(), env, 'session=not-a-real-jwt'));
    expect(res.status).toBe(302);
    expect(res.headers.get('Location') || '').toContain('/oauth/login-required');
  });

  it('session cookie 已过期 → 视为未登录', async () => {
    const env = await baseEnv();
    const now = Math.floor(Date.now() / 1000);
    const expired = await signJWT({ sub: 'alice@example.com', iat: now - 100, exp: now - 10 }, JWT_SECRET);
    const res = await fn.onRequestGet(ctx(authorizeUrl(), env, `session=${expired}`));
    expect(res.status).toBe(302);
    expect(res.headers.get('Location') || '').toContain('/oauth/login-required');
  });
});

describe('已登录', () => {
  it('302 带 code 和 state，code 落进 AUTH_KV', async () => {
    const env = await baseEnv();
    const cookie = await sessionCookieFor('alice@example.com');
    const res = await fn.onRequestGet(ctx(authorizeUrl(), env, cookie));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('Location') || '');
    expect(loc.origin + loc.pathname).toBe(REDIRECT_URI);
    expect(loc.searchParams.get('state')).toBe('xyz');
    const code = loc.searchParams.get('code');
    expect(code).toBeTruthy();
    const record = await kv.get(`oauth_code:${code}`, 'json');
    expect(record.client_id).toBe(CLIENT_ID);
    expect(record.redirect_uri).toBe(REDIRECT_URI);
    expect(record.code_challenge).toBe('abc123');
    expect(record.sub).toBe('alice@example.com');
  });

  it('响应带 Cache-Control: no-store（code 不能被 CDN 缓存）', async () => {
    const env = await baseEnv();
    const cookie = await sessionCookieFor('alice@example.com');
    const res = await fn.onRequestGet(ctx(authorizeUrl(), env, cookie));
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('redirect_uri 不在白名单', () => {
  it('→ 400', async () => {
    const env = await baseEnv();
    const cookie = await sessionCookieFor('alice@example.com');
    const res = await fn.onRequestGet(ctx(authorizeUrl({ redirect_uri: 'https://evil.example.com/callback' }), env, cookie));
    expect(res.status).toBe(400);
  });

  it('前缀匹配不算——多一个字符也拒', async () => {
    const env = await baseEnv();
    const cookie = await sessionCookieFor('alice@example.com');
    const res = await fn.onRequestGet(ctx(authorizeUrl({ redirect_uri: `${REDIRECT_URI}/extra` }), env, cookie));
    expect(res.status).toBe(400);
  });
});

describe('未知 client_id', () => {
  it('→ 400', async () => {
    const env = await baseEnv();
    const res = await fn.onRequestGet(ctx(authorizeUrl({ client_id: 'not-registered' }), env));
    expect(res.status).toBe(400);
  });
});

describe('code_challenge_method 不是 S256', () => {
  it('→ 400', async () => {
    const env = await baseEnv();
    const cookie = await sessionCookieFor('alice@example.com');
    const res = await fn.onRequestGet(ctx(authorizeUrl({ code_challenge_method: 'plain' }), env, cookie));
    expect(res.status).toBe(400);
  });
});

describe('缺配置', () => {
  it('OAUTH_CLIENTS 未配置 → 503', async () => {
    const res = await fn.onRequestGet(ctx(authorizeUrl(), { AUTH_JWT_SECRET: JWT_SECRET, AUTH_KV: kv }));
    expect(res.status).toBe(503);
  });
  it('AUTH_JWT_SECRET 未配置 → 503', async () => {
    const env = await baseEnv();
    delete (env as Record<string, unknown>).AUTH_JWT_SECRET;
    const res = await fn.onRequestGet(ctx(authorizeUrl(), env));
    expect(res.status).toBe(503);
  });
  it('AUTH_KV 未绑定 → 503', async () => {
    const env = await baseEnv();
    delete (env as Record<string, unknown>).AUTH_KV;
    const res = await fn.onRequestGet(ctx(authorizeUrl(), env));
    expect(res.status).toBe(503);
  });
});
