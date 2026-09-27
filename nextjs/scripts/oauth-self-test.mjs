#!/usr/bin/env node
// OA-授权端点自测脚本：模拟客户端走完整个「授权码 + PKCE」流程，不需要真的部署。
// 直接 import 边缘函数、拿 mock KV/env 跑，行为与生产版一致（EdgeOne Pages Function 的
// context.request/context.env 是标准 Fetch API + 普通对象，跟真部署里收到的形状一样）。
//
// 用法：cd nextjs && node scripts/oauth-self-test.mjs
//
// 走的步骤（对应任务书 §二 完成判据）：
//   1. 未登录访问 /oauth/authorize → 302 到 /oauth/login-required（带 return_to）
//   2. 未登录 + prompt=none → 302 回 redirect_uri?error=login_required
//   3. 模拟「已用邀请链接登录」（伪造 session cookie，与真实 /api/auth/join 签发的一样）
//   4. 已登录访问 /oauth/authorize → 302 带 code、state
//   5. 用 code + code_verifier 换 id_token（POST /oauth/token）→ 200，校验 claims 与签名
//   6. 同一个 code 再换一次 → 400（重放被拒）
//   7. 成员被停用后再走一遍 → access_denied（403）

import assert from 'node:assert/strict';

class MockKV {
  m = new Map();
  async put(k, v) { this.m.set(k, v); }
  async get(k, type) {
    const v = this.m.get(k);
    if (v === undefined) return null;
    if (type === 'json') { try { return JSON.parse(v); } catch { return null; } }
    return v;
  }
  async delete(k) { this.m.delete(k); }
}

function b64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return Buffer.from(bin, 'binary').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
async function sha256Hex(str) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function sha256B64url(str) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return b64url(new Uint8Array(digest));
}
async function signJWT(payload, secret) {
  const enc = new TextEncoder();
  const h = b64url(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const p = b64url(enc.encode(JSON.stringify(payload)));
  const data = `${h}.${p}`;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return `${data}.${b64url(new Uint8Array(sig))}`;
}
function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = str.length % 4;
  if (pad) str += '===='.slice(pad);
  return Buffer.from(str, 'base64');
}

const AUTH_JWT_SECRET = 'self-test-auth-jwt-secret-32bytes-xx';
const OAUTH_ID_TOKEN_SECRET = 'self-test-id-token-secret-32bytes-yy';
const CLIENT_ID = 'collate';
const CLIENT_SECRET = 'self-test-client-secret';
const REDIRECT_URI = 'http://127.0.0.1:9000/callback'; // 校对平台直连 IP 联调时的样子
const EMAIL = 'reviewer@example.com';

const kv = new MockKV();
const env = {
  AUTH_JWT_SECRET,
  AUTH_KV: kv,
  OAUTH_ID_TOKEN_SECRET,
  OAUTH_CLIENTS: JSON.stringify({
    [CLIENT_ID]: { secret_hash: await sha256Hex(CLIENT_SECRET), redirect_uris: [REDIRECT_URI] },
  }),
};

const authorize = await import('../../edge-functions/oauth/authorize.js');
const token = await import('../../edge-functions/oauth/token.js');

let step = 0;
function log(msg) { step += 1; console.log(`[${step}] ${msg}`); }

// PKCE：客户端自己生成 code_verifier，算出 code_challenge 带在 authorize 请求里
const codeVerifier = 'self-test-code-verifier-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
const codeChallenge = await sha256B64url(codeVerifier);

function authorizeUrl(extra = {}) {
  const p = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    state: 'self-test-state',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    ...extra,
  });
  return `https://www.kaiyuanguji.com/oauth/authorize?${p.toString()}`;
}

// 1. 未登录
{
  const res = await authorize.onRequestGet({ request: new Request(authorizeUrl()), env });
  assert.equal(res.status, 302);
  const loc = res.headers.get('Location');
  assert.ok(loc.includes('/oauth/login-required?'), 'should redirect to login-required page');
  log(`未登录 → 302 ${loc}`);
}

// 2. 未登录 + prompt=none
{
  const res = await authorize.onRequestGet({ request: new Request(authorizeUrl({ prompt: 'none' })), env });
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get('Location'));
  assert.equal(loc.searchParams.get('error'), 'login_required');
  log(`未登录 + prompt=none → 302 回 redirect_uri?error=login_required (${loc})`);
}

// 3. 模拟已用邀请链接登录：种下成员表 + 站内 session cookie（与真实 join.js 签发的同款）
await kv.put(`member:${EMAIL}`, JSON.stringify({ role: 'reviewer', joinedAt: Math.floor(Date.now() / 1000) }));
const now = Math.floor(Date.now() / 1000);
const sessionCookie = await signJWT({ sub: EMAIL, iat: now, exp: now + 180 * 24 * 3600 }, AUTH_JWT_SECRET);
log(`模拟已登录成员 ${EMAIL}（role=reviewer），种下 session cookie`);

// 4. 已登录 → 302 带 code
let code;
{
  const res = await authorize.onRequestGet({
    request: new Request(authorizeUrl(), { headers: { Cookie: `session=${sessionCookie}` } }),
    env,
  });
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get('Location'));
  assert.equal(loc.origin + loc.pathname, REDIRECT_URI);
  assert.equal(loc.searchParams.get('state'), 'self-test-state');
  code = loc.searchParams.get('code');
  assert.ok(code, 'code missing');
  log(`已登录 → 302 回 ${REDIRECT_URI}?code=${code}&state=self-test-state`);
}

// 5. 换 id_token
{
  const res = await token.onRequestPost({
    request: new Request('https://www.kaiyuanguji.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code_verifier: codeVerifier,
        redirect_uri: REDIRECT_URI,
      }),
    }),
    env,
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.id_token, 'id_token missing');
  const [h, p, s] = body.id_token.split('.');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(OAUTH_ID_TOKEN_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${h}.${p}`));
  assert.equal(b64url(new Uint8Array(sig)), s, 'id_token signature mismatch');
  const claims = JSON.parse(b64urlDecode(p).toString('utf8'));
  assert.equal(claims.iss, 'https://www.kaiyuanguji.com');
  assert.equal(claims.sub, EMAIL);
  assert.equal(claims.email, EMAIL);
  assert.equal(claims.role, 'reviewer');
  assert.equal(claims.aud, 'collate');
  assert.equal(claims.exp - claims.iat, 600);
  log(`换 id_token → 200，签名与 claims 均校验通过：${JSON.stringify(claims)}`);
}

// 6. 重放
{
  const res = await token.onRequestPost({
    request: new Request('https://www.kaiyuanguji.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code_verifier: codeVerifier,
        redirect_uri: REDIRECT_URI,
      }),
    }),
    env,
  });
  assert.equal(res.status, 400);
  log('同一个 code 再换一次 → 400（重放被拒）');
}

// 7. 成员停用后走一遍完整流程 → access_denied
{
  await kv.put(`member:${EMAIL}`, JSON.stringify({ role: 'reviewer', _deleted: true }));
  const res1 = await authorize.onRequestGet({
    request: new Request(authorizeUrl({ state: 'st2' }), { headers: { Cookie: `session=${sessionCookie}` } }),
    env,
  });
  const loc = new URL(res1.headers.get('Location'));
  const code2 = loc.searchParams.get('code');
  const res2 = await token.onRequestPost({
    request: new Request('https://www.kaiyuanguji.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code: code2,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code_verifier: codeVerifier,
        redirect_uri: REDIRECT_URI,
      }),
    }),
    env,
  });
  assert.equal(res2.status, 403);
  const j = await res2.json();
  assert.equal(j.error, 'access_denied');
  log('成员被停用后再走一遍 → 403 access_denied');
}

console.log('\n全部通过 ✓');
