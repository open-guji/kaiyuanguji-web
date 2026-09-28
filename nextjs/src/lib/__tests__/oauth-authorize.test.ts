/**
 * @jest-environment node
 *
 * OA-授权端点 /oauth/authorize 的完成判据（任务书 §二·1）：
 * 未登录页面提示、prompt=none→login_required、已登录→302 带 code/state、
 * redirect_uri 不在白名单→400、缺配置→503。
 *
 * 09-27 04:40Z 协调者验收第一轮后：code 改为自包含签名令牌，authorize 不再写 KV
 * （见 edge-functions/oauth/authorize.js 文件头）。
 *
 * FX3b（overview#196）：authorize 只读 AUTH_KV 查成员记录，令牌 tv 必须等于 tokenVersion，
 * 对不上／墓碑／查不到一律 401。测试用的 KV 写操作一调就抛，顺带证明 authorize 仍不写 KV。
 */

class ReadOnlyKV {
  m = new Map<string, string>();
  seed(k: string, v: unknown) { this.m.set(k, typeof v === 'string' ? v : JSON.stringify(v)); }
  async get(k: string, type?: string) {
    const v = this.m.get(k);
    if (v === undefined) return null;
    if (type === 'json') { try { return JSON.parse(v); } catch { return null; } }
    return v;
  }
  async put() { throw new Error('authorize 不应写 KV'); }
  async delete() { throw new Error('authorize 不应写 KV'); }
}

const JWT_SECRET = 'test-jwt-secret-32bytes-long-1234567890';
const CODE_SECRET = 'test-code-secret-32bytes-long-abcdefghij';
const CLIENT_ID = 'collate';
const CLIENT_SECRET = 'test-client-secret';
const REDIRECT_URI = 'https://collate.example.com/callback';

function b64url(bytes: Uint8Array) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return Buffer.from(bin, 'binary').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function b64urlDecode(str: string) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = str.length % 4;
  if (pad) str += '===='.slice(pad);
  return Buffer.from(str, 'base64');
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
async function verifyCode(token: string, secret: string) {
  const parts = token.split('.');
  expect(parts.length).toBe(3);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  expect(b64url(new Uint8Array(sig))).toBe(parts[2]);
  return JSON.parse(b64urlDecode(parts[1]).toString('utf8'));
}
// tv 传 null 表示令牌里不带 tv（FX3 之前签的旧令牌）
async function sessionCookieFor(email: string, tv: unknown = 1) {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = { sub: email, iat: now, exp: now + 3600 };
  if (tv !== null) payload.tv = tv;
  const token = await signJWT(payload, JWT_SECRET);
  return `session=${token}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fn: any;
let kv: ReadOnlyKV;

async function baseEnv() {
  return {
    AUTH_JWT_SECRET: JWT_SECRET,
    AUTH_KV: kv,
    OAUTH_CODE_SECRET: CODE_SECRET,
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
beforeEach(() => {
  kv = new ReadOnlyKV();
  kv.seed('member:alice@example.com', { role: 'reviewer', tokenVersion: 1 });
});

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
  it('302 带 code 和 state，code 是自包含签名令牌（cid/ruri/cc/sub 都对得上，不写 KV）', async () => {
    const env = await baseEnv();
    const cookie = await sessionCookieFor('alice@example.com');
    const res = await fn.onRequestGet(ctx(authorizeUrl(), env, cookie));
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('Location') || '');
    expect(loc.origin + loc.pathname).toBe(REDIRECT_URI);
    expect(loc.searchParams.get('state')).toBe('xyz');
    const code = loc.searchParams.get('code');
    expect(code).toBeTruthy();
    const payload = await verifyCode(code as string, CODE_SECRET);
    expect(payload.cid).toBe(CLIENT_ID);
    expect(payload.ruri).toBe(REDIRECT_URI);
    expect(payload.cc).toBe('abc123');
    expect(payload.sub).toBe('alice@example.com');
    expect(typeof payload.jti).toBe('string');
    expect(payload.jti.length).toBeGreaterThan(0);
    expect(payload.exp - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(60);
  });

  it('响应带 Cache-Control: no-store（code 不能被 CDN 缓存）', async () => {
    const env = await baseEnv();
    const cookie = await sessionCookieFor('alice@example.com');
    const res = await fn.onRequestGet(ctx(authorizeUrl(), env, cookie));
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('tokenVersion 比对（FX3b，接 FX3/H1）', () => {
  async function expect401NoCode(cookie: string) {
    const env = await baseEnv();
    const res = await fn.onRequestGet(ctx(authorizeUrl(), env, cookie));
    expect(res.status).toBe(401);
    expect(res.headers.get('Location')).toBeNull();
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const j = JSON.parse(await res.text());
    expect(j.error).toBe('login_required');
    return res;
  }

  it('令牌 tv 与成员记录 tokenVersion 对不上（改过角色／被撤销后的旧令牌）→ 401，不发 code', async () => {
    kv.seed('member:alice@example.com', { role: 'reviewer', tokenVersion: 2 });
    await expect401NoCode(await sessionCookieFor('alice@example.com', 1));
  });

  it('旧令牌没有 tv → 401', async () => {
    await expect401NoCode(await sessionCookieFor('alice@example.com', null));
  });

  it('旧成员记录没有 tokenVersion → 401', async () => {
    kv.seed('member:alice@example.com', { role: 'reviewer' });
    await expect401NoCode(await sessionCookieFor('alice@example.com', 1));
  });

  it('tv 类型不对（字符串 "1"）→ 401', async () => {
    await expect401NoCode(await sessionCookieFor('alice@example.com', '1'));
  });

  it('墓碑（_deleted）当作不存在 → 401，即使 tv 恰好对得上', async () => {
    kv.seed('member:alice@example.com', { role: 'reviewer', tokenVersion: 1, _deleted: true });
    await expect401NoCode(await sessionCookieFor('alice@example.com', 1));
  });

  it('成员记录不存在 → 401', async () => {
    await expect401NoCode(await sessionCookieFor('bob@example.com', 1));
  });

  it('prompt=none 时版本对不上同样 401，不静默发 code', async () => {
    kv.seed('member:alice@example.com', { role: 'reviewer', tokenVersion: 3 });
    const env = await baseEnv();
    const res = await fn.onRequestGet(ctx(authorizeUrl({ prompt: 'none' }), env, await sessionCookieFor('alice@example.com', 1)));
    expect(res.status).toBe(401);
  });

  it('版本对得上 → 302 带 code（KV 只读，没写）', async () => {
    kv.seed('member:alice@example.com', { role: 'editor', tokenVersion: 5 });
    const env = await baseEnv();
    const res = await fn.onRequestGet(ctx(authorizeUrl(), env, await sessionCookieFor('alice@example.com', 5)));
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('Location') || '').searchParams.get('code')).toBeTruthy();
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
    const res = await fn.onRequestGet(ctx(authorizeUrl(), { AUTH_JWT_SECRET: JWT_SECRET, OAUTH_CODE_SECRET: CODE_SECRET, AUTH_KV: kv }));
    expect(res.status).toBe(503);
  });
  it('AUTH_JWT_SECRET 未配置 → 503', async () => {
    const env = await baseEnv();
    delete (env as Record<string, unknown>).AUTH_JWT_SECRET;
    const res = await fn.onRequestGet(ctx(authorizeUrl(), env));
    expect(res.status).toBe(503);
  });
  it('OAUTH_CODE_SECRET 未配置 → 503', async () => {
    const env = await baseEnv();
    delete (env as Record<string, unknown>).OAUTH_CODE_SECRET;
    const res = await fn.onRequestGet(ctx(authorizeUrl(), env));
    expect(res.status).toBe(503);
  });
  it('AUTH_KV 未绑定 → 503（没法比对 tokenVersion 就不发 code）', async () => {
    const env = await baseEnv();
    delete (env as Record<string, unknown>).AUTH_KV;
    const res = await fn.onRequestGet(ctx(authorizeUrl(), env, await sessionCookieFor('alice@example.com')));
    expect(res.status).toBe(503);
  });
});
