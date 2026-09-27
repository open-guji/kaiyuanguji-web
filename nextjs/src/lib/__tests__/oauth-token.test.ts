/**
 * @jest-environment node
 *
 * OA-授权端点 /oauth/token 的完成判据（任务书 §二·1）：
 * token 正确→返回 id_token（claims 与签名都校验）；code 重放/过期/PKCE 不符/secret 错→一律拒绝；
 * 成员停用→access_denied；缺配置→503。
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

const ID_TOKEN_SECRET = 'test-id-token-secret-32bytes-abcdefghij';
const CLIENT_ID = 'collate';
const CLIENT_SECRET = 'test-client-secret';
const REDIRECT_URI = 'https://collate.example.com/callback';
const EMAIL = 'alice@example.com';

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
async function sha256B64url(str: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return b64url(new Uint8Array(digest));
}
async function verifyJWT(token: string, secret: string) {
  const parts = token.split('.');
  expect(parts.length).toBe(3);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  expect(b64url(new Uint8Array(sig))).toBe(parts[2]);
  return JSON.parse(b64urlDecode(parts[1]).toString('utf8'));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fn: any;
let kv: MockKV;

async function baseEnv() {
  return {
    OAUTH_ID_TOKEN_SECRET: ID_TOKEN_SECRET,
    AUTH_KV: kv,
    OAUTH_CLIENTS: JSON.stringify({
      [CLIENT_ID]: { secret_hash: await sha256Hex(CLIENT_SECRET), redirect_uris: [REDIRECT_URI] },
    }),
  };
}

async function seedMember(role = 'reviewer') {
  await kv.put(`member:${EMAIL}`, JSON.stringify({ role, joinedAt: Math.floor(Date.now() / 1000) }));
}

async function seedCode(overrides: Record<string, unknown> = {}) {
  const codeVerifier = 'test-code-verifier-abcdefghijklmnopqrstuvwxyz0123456789';
  const codeChallenge = await sha256B64url(codeVerifier);
  const code = 'test-code-000111222';
  const now = Math.floor(Date.now() / 1000);
  const record = {
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_challenge: codeChallenge,
    sub: EMAIL,
    exp: now + 60,
    ...overrides,
  };
  await kv.put(`oauth_code:${code}`, JSON.stringify(record));
  return { code, codeVerifier };
}

function tokenRequest(body: Record<string, unknown>, env: Record<string, unknown>) {
  return {
    request: new Request('https://www.kaiyuanguji.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
  };
}
function goodBody(code: string, codeVerifier: string, extra: Record<string, unknown> = {}) {
  return {
    grant_type: 'authorization_code',
    code,
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code_verifier: codeVerifier,
    redirect_uri: REDIRECT_URI,
    ...extra,
  };
}

beforeAll(async () => {
  fn = await import('../../../../edge-functions/oauth/token.js');
});
beforeEach(() => { kv = new MockKV(); });

describe('token 正确', () => {
  it('返回 id_token，claims 与签名都校验', async () => {
    const env = await baseEnv();
    await seedMember('reviewer');
    const { code, codeVerifier } = await seedCode();
    const res = await fn.onRequestPost(tokenRequest(goodBody(code, codeVerifier), env));
    expect(res.status).toBe(200);
    const j = JSON.parse(await res.text());
    expect(j.id_token).toBeTruthy();
    const claims = await verifyJWT(j.id_token, ID_TOKEN_SECRET);
    expect(claims.iss).toBe('https://www.kaiyuanguji.com');
    expect(claims.sub).toBe(EMAIL);
    expect(claims.email).toBe(EMAIL);
    expect(claims.role).toBe('reviewer');
    expect(claims.aud).toBe('collate');
    expect(typeof claims.iat).toBe('number');
    expect(claims.exp - claims.iat).toBe(600);
  });

  it('响应带 Cache-Control: no-store', async () => {
    const env = await baseEnv();
    await seedMember();
    const { code, codeVerifier } = await seedCode();
    const res = await fn.onRequestPost(tokenRequest(goodBody(code, codeVerifier), env));
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('一律拒绝', () => {
  it('code 重放：用过一次后第二次拒绝', async () => {
    const env = await baseEnv();
    await seedMember();
    const { code, codeVerifier } = await seedCode();
    const first = await fn.onRequestPost(tokenRequest(goodBody(code, codeVerifier), env));
    expect(first.status).toBe(200);
    const second = await fn.onRequestPost(tokenRequest(goodBody(code, codeVerifier), env));
    expect(second.status).toBe(400);
  });

  it('code 已过期', async () => {
    const env = await baseEnv();
    await seedMember();
    const now = Math.floor(Date.now() / 1000);
    const { code, codeVerifier } = await seedCode({ exp: now - 5 });
    const res = await fn.onRequestPost(tokenRequest(goodBody(code, codeVerifier), env));
    expect(res.status).toBe(400);
  });

  it('PKCE 不符：code_verifier 与签发时的 code_challenge 对不上', async () => {
    const env = await baseEnv();
    await seedMember();
    const { code } = await seedCode();
    const res = await fn.onRequestPost(tokenRequest(goodBody(code, 'wrong-verifier-xxxxxxxxxxxxxxxxxxxxxxxxxxxxx'), env));
    expect(res.status).toBe(400);
  });

  it('client_secret 错', async () => {
    const env = await baseEnv();
    await seedMember();
    const { code, codeVerifier } = await seedCode();
    const res = await fn.onRequestPost(tokenRequest(goodBody(code, codeVerifier, { client_secret: 'wrong-secret' }), env));
    expect(res.status).toBe(400);
  });

  it('code 不存在', async () => {
    const env = await baseEnv();
    await seedMember();
    const res = await fn.onRequestPost(tokenRequest(goodBody('never-issued-code', 'whatever-verifier-xxxxxxxxxxxxxxxxxxxxxxxx'), env));
    expect(res.status).toBe(400);
  });

  it('redirect_uri 与签发时不一致', async () => {
    const env = await baseEnv();
    await seedMember();
    const { code, codeVerifier } = await seedCode();
    const res = await fn.onRequestPost(tokenRequest(goodBody(code, codeVerifier, { redirect_uri: 'https://other.example.com/cb' }), env));
    expect(res.status).toBe(400);
  });

  it('grant_type 不是 authorization_code', async () => {
    const env = await baseEnv();
    const res = await fn.onRequestPost(tokenRequest({ grant_type: 'client_credentials' }, env));
    expect(res.status).toBe(400);
  });
});

describe('成员停用', () => {
  it('成员被标记 _deleted → access_denied', async () => {
    const env = await baseEnv();
    await kv.put(`member:${EMAIL}`, JSON.stringify({ role: 'reviewer', _deleted: true }));
    const { code, codeVerifier } = await seedCode();
    const res = await fn.onRequestPost(tokenRequest(goodBody(code, codeVerifier), env));
    expect(res.status).toBe(403);
    const j = JSON.parse(await res.text());
    expect(j.error).toBe('access_denied');
  });

  it('成员不存在 → access_denied', async () => {
    const env = await baseEnv();
    const { code, codeVerifier } = await seedCode();
    const res = await fn.onRequestPost(tokenRequest(goodBody(code, codeVerifier), env));
    expect(res.status).toBe(403);
    const j = JSON.parse(await res.text());
    expect(j.error).toBe('access_denied');
  });
});

describe('缺配置', () => {
  it('OAUTH_CLIENTS 未配置 → 503', async () => {
    const res = await fn.onRequestPost(tokenRequest({}, { OAUTH_ID_TOKEN_SECRET: ID_TOKEN_SECRET, AUTH_KV: kv }));
    expect(res.status).toBe(503);
  });
  it('OAUTH_ID_TOKEN_SECRET 未配置 → 503', async () => {
    const env = await baseEnv();
    delete (env as Record<string, unknown>).OAUTH_ID_TOKEN_SECRET;
    const res = await fn.onRequestPost(tokenRequest({}, env));
    expect(res.status).toBe(503);
  });
  it('AUTH_KV 未绑定 → 503', async () => {
    const env = await baseEnv();
    delete (env as Record<string, unknown>).AUTH_KV;
    const res = await fn.onRequestPost(tokenRequest({}, env));
    expect(res.status).toBe(503);
  });
});
