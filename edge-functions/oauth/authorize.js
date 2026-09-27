// GET /oauth/authorize — OAuth 2 授权码 + PKCE（网站当授权方，供校对平台等外部客户端换身份）
//
// 用网站自身登录态确认「这是谁」：cookie `session`（JWT，AUTH_JWT_SECRET 签）＋
// AUTH_KV 成员表，与 edge-functions/api/auth/* 同一套，只读复用、不改其行为、不签新登录态。
//
// 流程（RFC 6749 授权码 + RFC 7636 PKCE，只支持 S256）：
//   已登录 → 生成一次性 code（60 秒、单次，存 AUTH_KV）302 回 redirect_uri?code=…&state=…
//   未登录 → prompt=none：302 回 redirect_uri?error=login_required&state=…
//           否则：302 到本仓 nextjs 静态页 /oauth/login-required，登录后由该页带 return_to 回here
//
// 配置（EdgeOne Pages 环境变量，不进仓；缺一律 503）：
//   OAUTH_CLIENTS   JSON，client_id → { secret_hash, redirect_uris:[...] }
//                   secret_hash = sha256 hex(client_secret)，校验见 token.js
//   AUTH_JWT_SECRET／AUTH_KV  与 auth/* 共用（校验登录态、读成员表）

function getEnvVar(context, name) {
  if (context && context.env && context.env[name] !== undefined && context.env[name] !== null) {
    return context.env[name];
  }
  // eslint-disable-next-line no-undef
  return (typeof globalThis !== 'undefined' && name in globalThis) ? globalThis[name] : null;
}
const getJwtSecret = (c) => getEnvVar(c, 'AUTH_JWT_SECRET');
const getAuthKV = (c) => getEnvVar(c, 'AUTH_KV');
function getOAuthClients(c) {
  const raw = getEnvVar(c, 'OAUTH_CLIENTS');
  if (!raw) return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return (parsed && typeof parsed === 'object') ? parsed : null;
  } catch { return null; }
}

function getCookie(request, name) {
  const c = request.headers.get('cookie') || '';
  const m = c.match(new RegExp('(?:^|;\\s*)' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
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
async function verifyJWT(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const data = `${parts[0]}.${parts[1]}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const expect = b64urlEncode(new Uint8Array(sig));
  if (!constantTimeEqual(expect, parts[2])) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1])));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}
function randomCode() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const CODE_TTL_SECONDS = 60;
const noStore = { 'Cache-Control': 'no-store' };

function jsonError(status, error, description) {
  return new Response(
    JSON.stringify({ error, ...(description ? { error_description: description } : {}) }),
    { status, headers: { 'Content-Type': 'application/json', ...noStore } },
  );
}

export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);
  const q = url.searchParams;
  const clientId = q.get('client_id') || '';
  const redirectUri = q.get('redirect_uri') || '';
  const state = q.get('state') || '';
  const codeChallenge = q.get('code_challenge') || '';
  const codeChallengeMethod = q.get('code_challenge_method') || '';
  const prompt = q.get('prompt') || '';

  const clients = getOAuthClients(context);
  const jwtSecret = getJwtSecret(context);
  const kv = getAuthKV(context);
  if (!clients || !jwtSecret || !kv) {
    return jsonError(503, 'temporarily_unavailable', '服务未配置（OAUTH_CLIENTS／AUTH_JWT_SECRET／AUTH_KV）');
  }

  const client = clients[clientId];
  if (!clientId || !client || !Array.isArray(client.redirect_uris)) {
    return jsonError(400, 'invalid_client', '未知的 client_id');
  }
  if (!redirectUri || !client.redirect_uris.includes(redirectUri)) {
    return jsonError(400, 'invalid_request', 'redirect_uri 不在白名单');
  }
  if (!codeChallenge || codeChallengeMethod !== 'S256') {
    return jsonError(400, 'invalid_request', '缺少 code_challenge 或 code_challenge_method 不是 S256');
  }

  const sessionToken = getCookie(request, 'session');
  const payload = sessionToken ? await verifyJWT(sessionToken, jwtSecret) : null;
  const email = payload && payload.sub ? payload.sub : null;

  if (!email) {
    if (prompt === 'none') {
      const back = new URL(redirectUri);
      back.searchParams.set('error', 'login_required');
      if (state) back.searchParams.set('state', state);
      return new Response(null, { status: 302, headers: { Location: back.toString(), ...noStore } });
    }
    const returnTo = `/oauth/authorize${url.search}`;
    const loginPage = new URL('/oauth/login-required', url.origin);
    loginPage.searchParams.set('return_to', returnTo);
    return new Response(null, { status: 302, headers: { Location: loginPage.toString(), ...noStore } });
  }

  const code = randomCode();
  const now = Math.floor(Date.now() / 1000);
  const record = {
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    sub: email,
    exp: now + CODE_TTL_SECONDS,
  };
  await kv.put(`oauth_code:${code}`, JSON.stringify(record), { expirationTtl: CODE_TTL_SECONDS });

  const back = new URL(redirectUri);
  back.searchParams.set('code', code);
  if (state) back.searchParams.set('state', state);
  return new Response(null, { status: 302, headers: { Location: back.toString(), ...noStore } });
}

export function onRequestOptions() {
  return new Response(null, { status: 204, headers: { 'Allow': 'GET, OPTIONS' } });
}
