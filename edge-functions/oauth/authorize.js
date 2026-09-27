// GET /oauth/authorize — OAuth 2 授权码 + PKCE（网站当授权方，供校对平台等外部客户端换身份）
//
// 用网站自身登录态确认「这是谁」：cookie `session`（JWT，AUTH_JWT_SECRET 签），
// 与 edge-functions/api/auth/* 同一套，只读复用、不改其行为、不签新登录态。
//
// 流程（RFC 6749 授权码 + RFC 7636 PKCE，只支持 S256）：
//   已登录 → 生成一次性 code，302 回 redirect_uri?code=…&state=…
//   未登录 → prompt=none：302 回 redirect_uri?error=login_required&state=…
//           否则：302 到本仓 nextjs 静态页 /oauth/login-required，登录后由该页带 return_to 回here
//
// code 的形状（09-27 04:40Z 协调者验收第一轮定案，见任务书 §四）：
//   自包含的 HS256 JWT（`{cid,ruri,cc,sub,exp,jti}`），本函数**不写 KV**。
//   起因：/oauth/authorize 由读者浏览器命中的（国内）边缘节点执行，/oauth/token 由美国机
//   服务器调用，多半命中另一个边缘节点；EdgeOne KV 是最终一致存储，跨地域可见性有延迟，
//   code 又只有 60 秒——如果 code 存 KV，会出现「刚签的 code 换不到 token」（时好时坏、
//   难排查的 invalid_grant）。自包含令牌不需要跨节点读 KV 就能验证，天然绕开这个问题。
//   防重放改在 token.js 里查/记 `jti`（那次写读都在美国机发起的同一次请求链路里，不跨节点）。
//   取舍：token.js 记 jti 用的仍是 KV（先查后 put，TTL 120 秒）——如果 KV 传播恰好卡在两次
//   兑换之间，最坏情况是同一个 code 在 60 秒有效期内被换成两次 token；但重放者必须同时拿到
//   `client_secret` 和 `code_verifier`，这个风险面很小，判定可接受（细节见 token.js）。
//   对外接口不变：code 对客户端仍是不透明字符串。
//
// 配置（EdgeOne Pages 环境变量，不进仓；缺一律 503）：
//   OAUTH_CLIENTS    JSON，client_id → { secret_hash, redirect_uris:[...], aud? }
//                    secret_hash = sha256 hex(client_secret)，校验见 token.js
//   OAUTH_CODE_SECRET  签 code 用，与 AUTH_JWT_SECRET／OAUTH_ID_TOKEN_SECRET 都分开另起一把
//   AUTH_JWT_SECRET  与 auth/* 共用（校验站内登录态 cookie）

function getEnvVar(context, name) {
  if (context && context.env && context.env[name] !== undefined && context.env[name] !== null) {
    return context.env[name];
  }
  // eslint-disable-next-line no-undef
  return (typeof globalThis !== 'undefined' && name in globalThis) ? globalThis[name] : null;
}
const getJwtSecret = (c) => getEnvVar(c, 'AUTH_JWT_SECRET');
const getCodeSecret = (c) => getEnvVar(c, 'OAUTH_CODE_SECRET');
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
function randomJti() {
  const bytes = new Uint8Array(16);
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
  const codeSecret = getCodeSecret(context);
  if (!clients || !jwtSecret || !codeSecret) {
    return jsonError(503, 'temporarily_unavailable', '服务未配置（OAUTH_CLIENTS／AUTH_JWT_SECRET／OAUTH_CODE_SECRET）');
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

  const now = Math.floor(Date.now() / 1000);
  const code = await signJWT({
    cid: clientId,
    ruri: redirectUri,
    cc: codeChallenge,
    sub: email,
    exp: now + CODE_TTL_SECONDS,
    jti: randomJti(),
  }, codeSecret);

  const back = new URL(redirectUri);
  back.searchParams.set('code', code);
  if (state) back.searchParams.set('state', state);
  return new Response(null, { status: 302, headers: { Location: back.toString(), ...noStore } });
}

export function onRequestOptions() {
  return new Response(null, { status: 204, headers: { 'Allow': 'GET, OPTIONS' } });
}
