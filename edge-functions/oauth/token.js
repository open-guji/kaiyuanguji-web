// POST /oauth/token — 服务器对服务器：用授权码换 id_token（RFC 6749 §4.1.3 + PKCE 校验）
//
// code 是 authorize.js 签发的自包含 HS256 JWT（`{cid,ruri,cc,sub,exp,jti}`，OAUTH_CODE_SECRET
// 签），不存在 KV 里（原因见 authorize.js 文件头：/oauth/authorize 与 /oauth/token 大概率落在
// 不同边缘节点，KV 最终一致、跨地域可见有延迟，code 只有 60 秒，存 KV 会时好时坏地换不到 token）。
// 校验顺序：验签＋`exp` → `cid`／`ruri` 与本次请求一致 → PKCE → 查/记 `jti`（KV，防重放，
// TTL 120 秒——细节见下）→ 查成员表签 id_token。
//
// jti 防重放的取舍：先查 KV 里有没有这个 jti，没有就 put（TTL 120 秒，覆盖 code 60 秒有效期
// 加余量）。这一读一写都在同一次 /oauth/token 请求里、同一台美国机发起，不跨节点，KV 传播延迟
// 不是主要风险；真正的风险是两次并发请求同时读到「没有」再各自 put——最坏情况下同一个 code
// 在有效期内被换成两次 token。但重放者要同时拿到 `client_secret`（服务器对服务器密钥，不随
// code 走网络）和 `code_verifier`（客户端本地生成，不随 authorize 请求外泄），双重门槛下这
// 个残余风险判定可接受。
//
// 请求体 grant_type=authorization_code、code、client_id、client_secret、code_verifier、
// redirect_uri；同时接受 JSON 与 application/x-www-form-urlencoded（标准 OAuth 客户端多用后者）。
// 成员被停用或删除：返回 access_denied（403），因为不是「请求本身有问题」。
//
// 配置（EdgeOne Pages 环境变量，不进仓；缺一律 503）：
//   OAUTH_CLIENTS          同 authorize.js；secret_hash = sha256 hex(client_secret)，
//                          可选 aud（不配就用 client_id 当 id_token 的 aud）
//   OAUTH_CODE_SECRET      验 code 签名，与 authorize.js 用同一把
//   OAUTH_ID_TOKEN_SECRET  id_token 签名密钥，与 AUTH_JWT_SECRET／OAUTH_CODE_SECRET 都分开
//   AUTH_KV                与 auth/* 共用（记 jti、查成员表）

function getEnvVar(context, name) {
  if (context && context.env && context.env[name] !== undefined && context.env[name] !== null) {
    return context.env[name];
  }
  // eslint-disable-next-line no-undef
  return (typeof globalThis !== 'undefined' && name in globalThis) ? globalThis[name] : null;
}
const getCodeSecret = (c) => getEnvVar(c, 'OAUTH_CODE_SECRET');
const getIdTokenSecret = (c) => getEnvVar(c, 'OAUTH_ID_TOKEN_SECRET');
const getAuthKV = (c) => getEnvVar(c, 'AUTH_KV');
function getOAuthClients(c) {
  const raw = getEnvVar(c, 'OAUTH_CLIENTS');
  if (!raw) return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return (parsed && typeof parsed === 'object') ? parsed : null;
  } catch { return null; }
}

function toHex(buf) {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
function b64urlEncode(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = str.length % 4;
  if (pad) str += '===='.slice(pad);
  const bin = atob(str);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
  return arr;
}
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function sha256Hex(str) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return toHex(digest);
}
async function sha256B64url(str) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return b64urlEncode(new Uint8Array(digest));
}
async function hmacSign(data, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return b64urlEncode(new Uint8Array(sig));
}
async function verifyJWT(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const data = `${parts[0]}.${parts[1]}`;
  const expect = await hmacSign(data, secret);
  if (!constantTimeEqual(expect, parts[2])) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}
async function signJWT(payload, secret) {
  const h = b64urlEncode(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const p = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const data = `${h}.${p}`;
  const s = await hmacSign(data, secret);
  return `${data}.${s}`;
}

const JTI_TTL_SECONDS = 120;

async function parseBody(request) {
  const ct = request.headers.get('content-type') || '';
  let text = '';
  try { text = await request.text(); } catch { text = ''; }
  if (ct.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    try { return Object.fromEntries(new URLSearchParams(text)); } catch { return {}; }
  }
}

function noStoreHeaders() {
  return { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Pragma: 'no-cache' };
}
function errorResponse(status, error, description) {
  return new Response(
    JSON.stringify({ error, ...(description ? { error_description: description } : {}) }),
    { status, headers: noStoreHeaders() },
  );
}

export async function onRequestPost(context) {
  const { request } = context;
  const clients = getOAuthClients(context);
  const codeSecret = getCodeSecret(context);
  const idTokenSecret = getIdTokenSecret(context);
  const kv = getAuthKV(context);
  if (!clients || !codeSecret || !idTokenSecret || !kv) {
    return errorResponse(503, 'temporarily_unavailable', '服务未配置（OAUTH_CLIENTS／OAUTH_CODE_SECRET／OAUTH_ID_TOKEN_SECRET／AUTH_KV）');
  }

  const body = await parseBody(request);
  const grantType = String(body.grant_type || '');
  const code = String(body.code || '');
  const clientId = String(body.client_id || '');
  const clientSecret = String(body.client_secret || '');
  const codeVerifier = String(body.code_verifier || '');
  const redirectUri = String(body.redirect_uri || '');

  if (grantType !== 'authorization_code') {
    return errorResponse(400, 'unsupported_grant_type');
  }
  if (!code || !clientId || !clientSecret || !codeVerifier || !redirectUri) {
    return errorResponse(400, 'invalid_request', '缺少必填参数');
  }

  const client = clients[clientId];
  if (!client || typeof client.secret_hash !== 'string') {
    return errorResponse(400, 'invalid_client');
  }
  const suppliedHash = await sha256Hex(clientSecret);
  if (!constantTimeEqual(suppliedHash, client.secret_hash)) {
    console.error('oauth token: client_secret 不匹配', clientId);
    return errorResponse(400, 'invalid_client');
  }

  const payload = await verifyJWT(code, codeSecret);
  if (!payload || !payload.jti || !payload.cid || !payload.ruri || !payload.sub) {
    console.error('oauth token: code 验签失败或已过期');
    return errorResponse(400, 'invalid_grant');
  }
  if (payload.cid !== clientId || payload.ruri !== redirectUri) {
    console.error('oauth token: code 与签发时的 client_id/redirect_uri 不一致');
    return errorResponse(400, 'invalid_grant');
  }
  const challengeExpect = await sha256B64url(codeVerifier);
  if (!payload.cc || !constantTimeEqual(challengeExpect, payload.cc)) {
    console.error('oauth token: PKCE 校验失败');
    return errorResponse(400, 'invalid_grant');
  }

  const jtiKey = `oauth_code_jti:${payload.jti}`;
  let usedAlready = null;
  try { usedAlready = await kv.get(jtiKey); } catch { usedAlready = null; }
  if (usedAlready) {
    console.error('oauth token: code 已被使用过（jti 重放）');
    return errorResponse(400, 'invalid_grant');
  }
  await kv.put(jtiKey, '1', { expirationTtl: JTI_TTL_SECONDS });

  const email = payload.sub;
  let member = null;
  try { member = await kv.get(`member:${email}`, 'json'); } catch { member = null; }
  if (!member || typeof member !== 'object' || member._deleted || !member.role) {
    return errorResponse(403, 'access_denied', '成员已停用或不存在');
  }

  const now = Math.floor(Date.now() / 1000);
  const idToken = await signJWT({
    iss: 'https://www.kaiyuanguji.com',
    sub: email,
    email,
    role: member.role,
    aud: client.aud || clientId,
    iat: now,
    exp: now + 600,
  }, idTokenSecret);

  return new Response(
    JSON.stringify({ id_token: idToken, token_type: 'Bearer', expires_in: 600 }),
    { status: 200, headers: noStoreHeaders() },
  );
}

export function onRequestOptions() {
  return new Response(null, { status: 204, headers: { 'Allow': 'POST, OPTIONS' } });
}
