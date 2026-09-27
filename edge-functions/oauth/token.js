// POST /oauth/token — 服务器对服务器：用授权码换 id_token（RFC 6749 §4.1.3 + PKCE 校验）
//
// 校验 client_secret／code／PKCE／redirect_uri 与签发时（authorize.js）一致；
// code 用过即删（查到就摘牌，不论后续校验是否通过，杜绝并发重放）；
// 重放（摘牌后再查不到）／过期／PKCE 不符／secret 错，一律拒绝（400）并记日志；
// 成员被停用或删除：单独判为 access_denied（403），因为不是「请求本身有问题」。
//
// 请求体 grant_type=authorization_code、code、client_id、client_secret、code_verifier、
// redirect_uri；同时接受 JSON 与 application/x-www-form-urlencoded（标准 OAuth 客户端多用后者）。
//
// 配置（EdgeOne Pages 环境变量，不进仓；缺一律 503）：
//   OAUTH_CLIENTS          同 authorize.js；secret_hash = sha256 hex(client_secret)
//   OAUTH_ID_TOKEN_SECRET  id_token 签名密钥，与 AUTH_JWT_SECRET 分开另起一把
//   AUTH_KV                与 auth/* 共用（取 code 记录、查成员表）

function getEnvVar(context, name) {
  if (context && context.env && context.env[name] !== undefined && context.env[name] !== null) {
    return context.env[name];
  }
  // eslint-disable-next-line no-undef
  return (typeof globalThis !== 'undefined' && name in globalThis) ? globalThis[name] : null;
}
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
async function signJWT(payload, secret) {
  const h = b64urlEncode(new TextEncoder().encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const p = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const data = `${h}.${p}`;
  const s = await hmacSign(data, secret);
  return `${data}.${s}`;
}

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
  const idTokenSecret = getIdTokenSecret(context);
  const kv = getAuthKV(context);
  if (!clients || !idTokenSecret || !kv) {
    return errorResponse(503, 'temporarily_unavailable', '服务未配置（OAUTH_CLIENTS／OAUTH_ID_TOKEN_SECRET／AUTH_KV）');
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

  const codeKey = `oauth_code:${code}`;
  let record = null;
  try { record = await kv.get(codeKey, 'json'); } catch { record = null; }
  if (!record) {
    console.error('oauth token: code 不存在（已用过／已过期／无效）');
    return errorResponse(400, 'invalid_grant');
  }
  // 查到就摘牌：不论后面校验是否通过，先让它单次作废，杜绝并发重放。
  await kv.delete(codeKey);

  const now = Math.floor(Date.now() / 1000);
  if (record.exp && record.exp < now) {
    console.error('oauth token: code 已过期');
    return errorResponse(400, 'invalid_grant');
  }
  if (record.client_id !== clientId || record.redirect_uri !== redirectUri) {
    console.error('oauth token: code 与签发时的 client_id/redirect_uri 不一致');
    return errorResponse(400, 'invalid_grant');
  }
  const challengeExpect = await sha256B64url(codeVerifier);
  if (!record.code_challenge || !constantTimeEqual(challengeExpect, record.code_challenge)) {
    console.error('oauth token: PKCE 校验失败');
    return errorResponse(400, 'invalid_grant');
  }

  const email = record.sub;
  let member = null;
  try { member = await kv.get(`member:${email}`, 'json'); } catch { member = null; }
  if (!member || typeof member !== 'object' || member._deleted || !member.role) {
    return errorResponse(403, 'access_denied', '成员已停用或不存在');
  }

  const idToken = await signJWT({
    iss: 'https://www.kaiyuanguji.com',
    sub: email,
    email,
    role: member.role,
    aud: 'collate',
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
