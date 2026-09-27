#!/usr/bin/env node
// OA-授权端点自测脚本：模拟客户端走完整个「授权码 + PKCE」流程，不需要真的部署。
// 直接 import 边缘函数、拿 mock KV/env 跑，行为与生产版一致（EdgeOne Pages Function 的
// context.request/context.env 是标准 Fetch API + 普通对象，跟真部署里收到的形状一样）。
//
// 用法：cd nextjs && node scripts/oauth-self-test.mjs
//
// 走的步骤（对应任务书 §二 完成判据 ＋ 09-27 04:40Z 协调者验收第一轮补的架构验证）：
//   1. 未登录访问 /oauth/authorize → 302 到 /oauth/login-required（带 return_to）
//   2. 未登录 + prompt=none → 302 回 redirect_uri?error=login_required
//   3. 模拟「已用邀请链接登录」（伪造 session cookie，与真实 /api/auth/join 签发的一样）
//   4. 已登录访问 /oauth/authorize → 302 带 code、state（code 是自包含签名令牌，不写 KV）
//   5. 跨 KV 实例照样能换 token（模拟 authorize 与 token 落在不同边缘节点，KV 互不可见）
//   6. 用 code + code_verifier 换 id_token（POST /oauth/token）→ 200，校验 claims 与签名
//   7. 同一个 code 再换一次 → 400（jti 重放被拒）
//   8. 成员被停用后再走一遍 → access_denied（403）

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
const OAUTH_CODE_SECRET = 'self-test-code-secret-32bytes-zzzzzz';
const OAUTH_ID_TOKEN_SECRET = 'self-test-id-token-secret-32bytes-yy';
const CLIENT_ID = 'collate';
const CLIENT_SECRET = 'self-test-client-secret';
const REDIRECT_URI = 'http://127.0.0.1:9000/callback'; // 校对平台直连 IP 联调时的样子
const EMAIL = 'reviewer@example.com';

const oauthClients = JSON.stringify({
  [CLIENT_ID]: { secret_hash: await sha256Hex(CLIENT_SECRET), redirect_uris: [REDIRECT_URI] },
});
// authorize 不写 KV（见 authorize.js 文件头），所以它的 env 里压根不需要 AUTH_KV。
const authorizeEnv = { AUTH_JWT_SECRET, OAUTH_CODE_SECRET, OAUTH_CLIENTS: oauthClients };
// token 端要查成员表、记 jti 防重放，需要 AUTH_KV；下面每次都传一个「假装是另一个边缘节点」的 KV 实例。
function freshTokenEnv(kv) {
  return { OAUTH_CODE_SECRET, OAUTH_ID_TOKEN_SECRET, AUTH_KV: kv, OAUTH_CLIENTS: oauthClients };
}

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

function tokenReq(code, verifier, kv, extra = {}) {
  return token.onRequestPost({
    request: new Request('https://www.kaiyuanguji.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
        ...extra,
      }),
    }),
    env: freshTokenEnv(kv),
  });
}

// 1. 未登录
{
  const res = await authorize.onRequestGet({ request: new Request(authorizeUrl()), env: authorizeEnv });
  assert.equal(res.status, 302);
  const loc = res.headers.get('Location');
  assert.ok(loc.includes('/oauth/login-required?'), 'should redirect to login-required page');
  log(`未登录 → 302 ${loc}`);
}

// 2. 未登录 + prompt=none
{
  const res = await authorize.onRequestGet({ request: new Request(authorizeUrl({ prompt: 'none' })), env: authorizeEnv });
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get('Location'));
  assert.equal(loc.searchParams.get('error'), 'login_required');
  log(`未登录 + prompt=none → 302 回 redirect_uri?error=login_required (${loc})`);
}

// 3. 模拟已用邀请链接登录：种下 session cookie（与真实 join.js 签发的同款）；
//    成员表种在哪个 KV 由后面各步自己决定（authorize 本身不查成员表、不碰 KV）。
const now = Math.floor(Date.now() / 1000);
const sessionCookie = await signJWT({ sub: EMAIL, iat: now, exp: now + 180 * 24 * 3600 }, AUTH_JWT_SECRET);
log(`模拟已登录成员 ${EMAIL}（role=reviewer），站内 session cookie 就绪`);

// 4. 已登录 → 302 带 code（自包含签名令牌，authorize 全程没碰任何 KV）
let code;
{
  const res = await authorize.onRequestGet({
    request: new Request(authorizeUrl(), { headers: { Cookie: `session=${sessionCookie}` } }),
    env: authorizeEnv,
  });
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get('Location'));
  assert.equal(loc.origin + loc.pathname, REDIRECT_URI);
  assert.equal(loc.searchParams.get('state'), 'self-test-state');
  code = loc.searchParams.get('code');
  assert.ok(code, 'code missing');
  log(`已登录 → 302 回 ${REDIRECT_URI}?code=${code.slice(0, 24)}...&state=self-test-state`);
}

// 5. 跨 KV 实例也能换 token：模拟 authorize 落在边缘节点 A（上面全程没写过 KV），
//    token 请求落在边缘节点 B——B 的 KV 从未见过这个 code，只要现查得到成员表就行。
{
  const kvNodeB = new MockKV();
  await kvNodeB.put(`member:${EMAIL}`, JSON.stringify({ role: 'reviewer', joinedAt: now }));
  const res = await tokenReq(code, codeVerifier, kvNodeB);
  assert.equal(res.status, 200);
  log('跨 KV 实例（node B 从未见过这个 code）照样换到 200 —— 不依赖跨节点 KV 传播');
}

// 6. 正式换 id_token（用于后续校验 claims/签名，走独立的「主 KV」）
const kv = new MockKV();
await kv.put(`member:${EMAIL}`, JSON.stringify({ role: 'reviewer', joinedAt: now }));
{
  const res = await tokenReq(code, codeVerifier, kv);
  // 第 5 步已经把这个 jti 记在 kvNodeB 里，但 kv 是另一个全新实例，看不到那条记录——
  // 这正是「跨 KV 实例」取舍的另一面：同一个 code 理论上能在不同节点各自换一次
  // （见 authorize.js／token.js 文件头的风险说明），这里如实演示，不是 bug。
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

// 7. 同一个 KV 实例上重放同一个 code → 拒绝（jti 已记过）
{
  const res = await tokenReq(code, codeVerifier, kv);
  assert.equal(res.status, 400);
  log('同一个 code 在同一 KV 实例上再换一次 → 400（jti 重放被拒）');
}

// 8. 成员停用后走一遍完整流程 → access_denied
{
  await kv.put(`member:${EMAIL}`, JSON.stringify({ role: 'reviewer', _deleted: true }));
  const res1 = await authorize.onRequestGet({
    request: new Request(authorizeUrl({ state: 'st2' }), { headers: { Cookie: `session=${sessionCookie}` } }),
    env: authorizeEnv,
  });
  const loc = new URL(res1.headers.get('Location'));
  const code2 = loc.searchParams.get('code');
  const res2 = await tokenReq(code2, codeVerifier, kv);
  assert.equal(res2.status, 403);
  const j = await res2.json();
  assert.equal(j.error, 'access_denied');
  log('成员被停用后再走一遍 → 403 access_denied');
}

console.log('\n全部通过 ✓');
