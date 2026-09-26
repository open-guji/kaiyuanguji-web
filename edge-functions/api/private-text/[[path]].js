// GET /api/private-text/<相对路径> — 私有文本代理（EdgeOne Pages Function）
//
// 私有文本来自私有仓 open-guji-core/book-text-private（文本总管维护，目录/schema
// 与公开仓 book-text 完全相同）。打包时该仓不进公开 COS 路径（current/、v/、h1/、
// 搜索分片、sitemap），单独同步到同一 COS 桶下的**私有前缀**（该前缀已关闭匿名读，
// 见 nextjs/scripts/sync-private-text-to-cos.mjs）。本端点是唯一读取入口：
// 用服务端密钥对 COS 请求签名（Tencent COS 签名 v5，HMAC-SHA1），代客户端取回对象、
// 原样转发内容，本函数自己不缓存、不写。
//
// 鉴权口径表（判定顺序即代码顺序，互不覆盖）：
//   ┌────────────────────────────────────────────┬──────┐
//   │ 情形                                          │ 状态 │
//   ├────────────────────────────────────────────┼──────┤
//   │ AUTH_JWT_SECRET 未配置                        │ 503  │
//   │ 无 session cookie                             │ 401  │
//   │ session cookie 校验失败（签名/过期）           │ 401  │
//   │ AUTH_KV 未绑定                                │ 503  │
//   │ 成员不存在或已被移除（_deleted）               │ 401  │
//   │ 成员角色不在 {internal, admin}                │ 403  │
//   │ 私有 COS 凭据/桶未配置                        │ 503  │
//   │ 相对路径为空或含 `..` 上跳                    │ 400  │
//   │ COS 对象不存在                                │ 404  │
//   │ 其余（签名/COS 侧非预期错误）                  │ 502  │
//   └────────────────────────────────────────────┴──────┘
//
// 响应固定 `Cache-Control: private, no-store`——内容按角色而异，绝不能进 CDN
// 公共缓存或被同源其它访客的浏览器缓存复用。
//
// 绑定/配置（EdgeOne Pages 控制台，与 auth/* 共用 AUTH_JWT_SECRET／AUTH_KV）：
//   PRIVATE_COS_READ_SECRET_ID / PRIVATE_COS_READ_SECRET_KEY
//       只需对私有前缀 GetObject 的权限（建议子账号 + Bucket Policy 限定
//       到 PRIVATE_COS_PREFIX 下，不要用发布用的全量读写 COS_SECRET_ID/KEY——
//       那对凭据被打包进构建产物的风险面更大，这里是常驻在边缘运行时里的密钥）
//   PRIVATE_COS_BUCKET       COS 桶名（与公开数据同桶即可，靠前缀隔离）
//   PRIVATE_COS_REGION       可选，默认 ap-singapore（须与公开桶实际地域一致，
//                            deploy.yml 里公开同步步骤显式传 ap-singapore）
//   PRIVATE_COS_PREFIX       可选，默认 "private/book-text-private"（桶内私有前缀，
//                            末尾不带 /；须与 sync-private-text-to-cos.mjs 的
//                            COS_PATH_PREFIX 一致）

const ALLOWED_ORIGINS = [
  'https://www.kaiyuanguji.com',
  'https://kaiyuanguji.com',
  'https://open-guji.github.io',
  'http://localhost:3000',
  'http://localhost:5173',
];
const ALLOWED_ROLES = ['internal', 'admin'];

function getCorsHeaders(request) {
  const origin = request.headers.get('origin') || '';
  const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return { 'Access-Control-Allow-Origin': corsOrigin, 'Cache-Control': 'private, no-store' };
}

function getEnvVar(context, name) {
  if (context && context.env && context.env[name] !== undefined && context.env[name] !== null) {
    return context.env[name];
  }
  // eslint-disable-next-line no-undef
  return (typeof globalThis !== 'undefined' && name in globalThis) ? globalThis[name] : null;
}
const getJwtSecret = (c) => getEnvVar(c, 'AUTH_JWT_SECRET');
const getAuthKV = (c) => getEnvVar(c, 'AUTH_KV');
const getCosSecretId = (c) => getEnvVar(c, 'PRIVATE_COS_READ_SECRET_ID');
const getCosSecretKey = (c) => getEnvVar(c, 'PRIVATE_COS_READ_SECRET_KEY');
const getCosBucket = (c) => getEnvVar(c, 'PRIVATE_COS_BUCKET');
const getCosRegion = (c) => getEnvVar(c, 'PRIVATE_COS_REGION') || 'ap-singapore';
const getCosPrefix = (c) => {
  const v = getEnvVar(c, 'PRIVATE_COS_PREFIX');
  return (v || 'private/book-text-private').replace(/^\/+|\/+$/g, '');
};

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
function toHex(buf) {
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function hmacSha256Hex(data, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return toHex(sig);
}
function b64urlEncode(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
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

/**
 * 鉴权：登录 cookie → 成员表角色。返回 {ok:true, email} 或 {ok:false, status, error}。
 * 与 auth/me.js 同一份成员表（AUTH_KV `member:<email>`），但角色白名单不同
 * （这里只放 internal／admin，reviewer／editor 不能看私有文本）。
 */
async function checkPrivateTextAuth(request, context) {
  const jwtSecret = getJwtSecret(context);
  if (!jwtSecret) return { ok: false, status: 503, error: '服务未配置 AUTH_JWT_SECRET' };
  const token = getCookie(request, 'session');
  if (!token) return { ok: false, status: 401, error: '未登录' };
  const payload = await verifyJWT(token, jwtSecret);
  if (!payload || !payload.sub) return { ok: false, status: 401, error: '未登录' };
  const kv = getAuthKV(context);
  if (!kv) return { ok: false, status: 503, error: '服务未配置 AUTH_KV' };
  let member = null;
  try { member = await kv.get(`member:${payload.sub}`, 'json'); } catch { member = null; }
  if (!member || typeof member !== 'object' || member._deleted || !member.role) {
    return { ok: false, status: 401, error: '成员不存在或已移除' };
  }
  if (!ALLOWED_ROLES.includes(member.role)) {
    return { ok: false, status: 403, error: '角色不符，需 internal 或 admin' };
  }
  return { ok: true, email: payload.sub, role: member.role };
}

/** Tencent COS 签名 v5（HMAC-SHA1）。只签路径，不签任何请求头/查询参数——GET 单对象够用。 */
async function sha1Hex(str) {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
  return toHex(digest);
}
async function hmacSha1Hex(secret, data) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return toHex(sig);
}
function encodeCosPath(key) {
  return '/' + key.split('/').map(encodeURIComponent).join('/');
}
async function signCosGet(secretId, secretKey, objectKey) {
  const now = Math.floor(Date.now() / 1000);
  const start = now - 60; // 容忍边缘节点与 COS 之间的轻微时钟偏差
  const end = now + 300; // 签名 5 分钟内有效，够单次代理请求用
  const keyTime = `${start};${end}`;
  const signKey = await hmacSha1Hex(secretKey, keyTime);
  const httpString = `get\n${encodeCosPath(objectKey)}\n\n\n`;
  const stringToSign = `sha1\n${keyTime}\n${await sha1Hex(httpString)}\n`;
  const signature = await hmacSha1Hex(signKey, stringToSign);
  return [
    'q-sign-algorithm=sha1',
    `q-ak=${secretId}`,
    `q-sign-time=${keyTime}`,
    `q-key-time=${keyTime}`,
    'q-header-list=',
    'q-url-param-list=',
    `q-signature=${signature}`,
  ].join('&');
}

function contentTypeFor(relative) {
  const i = relative.lastIndexOf('.');
  const ext = i < 0 ? '' : relative.slice(i + 1).toLowerCase();
  switch (ext) {
    case 'json': return 'application/json; charset=utf-8';
    case 'md': return 'text/markdown; charset=utf-8';
    case 'txt': return 'text/plain; charset=utf-8';
    default: return 'application/octet-stream';
  }
}

/** 相对路径校验：非空、不含 `..` 上跳段、不以 / 开头（catch-all 已按段拆好）。 */
function invalidRelativePath(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return true;
  return segments.some((s) => !s || s === '.' || s === '..');
}

export async function onRequestGet(context) {
  const headers = getCorsHeaders(context.request);
  headers['Content-Type'] = 'application/json';

  const auth = await checkPrivateTextAuth(context.request, context);
  if (!auth.ok) {
    return new Response(JSON.stringify({ success: false, error: auth.error }), { status: auth.status, headers });
  }

  const secretId = getCosSecretId(context);
  const secretKey = getCosSecretKey(context);
  const bucket = getCosBucket(context);
  if (!secretId || !secretKey || !bucket) {
    return new Response(JSON.stringify({ success: false, error: '服务未配置私有 COS 凭据（PRIVATE_COS_READ_SECRET_ID/KEY/PRIVATE_COS_BUCKET）' }), { status: 503, headers });
  }

  // EdgeOne Pages Function 的 [[path]] catch-all：context.params.path 是按段拆好的数组
  // （不是原始未拆分字符串），与 Cloudflare Pages Functions 同一约定。
  const segments = (context.params && context.params.path) || [];
  if (invalidRelativePath(segments)) {
    return new Response(JSON.stringify({ success: false, error: '无效路径' }), { status: 400, headers });
  }
  const relative = segments.map(decodeURIComponent).join('/');
  const objectKey = `${getCosPrefix(context)}/${relative}`;

  const region = getCosRegion(context);
  const host = `${bucket}.cos.${region}.myqcloud.com`;
  let authorization;
  try {
    authorization = await signCosGet(secretId, secretKey, objectKey);
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: `签名失败: ${e.message || e}` }), { status: 502, headers });
  }

  let cosRes;
  try {
    cosRes = await fetch(`https://${host}${encodeCosPath(objectKey)}`, {
      method: 'GET',
      headers: { Authorization: authorization },
    });
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: `取私有对象失败: ${e.message || e}` }), { status: 502, headers });
  }

  if (cosRes.status === 404) {
    return new Response(JSON.stringify({ success: false, error: '对象不存在' }), { status: 404, headers });
  }
  if (!cosRes.ok) {
    // COS 侧非预期错误（含我方凭据/权限配错导致的 403）：不是调用方的锅，也不该
    // 把 COS 原始报文透出去（可能含桶名/密钥相关线索），一律折成 502。
    console.error('private-text COS error', cosRes.status, await cosRes.text().catch(() => ''));
    return new Response(JSON.stringify({ success: false, error: 'COS 侧错误' }), { status: 502, headers });
  }

  const body = await cosRes.arrayBuffer();
  const outHeaders = getCorsHeaders(context.request);
  outHeaders['Content-Type'] = contentTypeFor(relative);
  return new Response(body, { status: 200, headers: outHeaders });
}

export function onRequestOptions(context) {
  const headers = getCorsHeaders(context.request);
  headers['Access-Control-Allow-Methods'] = 'GET, OPTIONS';
  headers['Access-Control-Allow-Headers'] = 'Content-Type';
  headers['Access-Control-Max-Age'] = '86400';
  return new Response(null, { status: 204, headers });
}
