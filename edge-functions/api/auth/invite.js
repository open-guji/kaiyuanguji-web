// POST /api/auth/invite — 管理员生成邀请链接（需 admin cookie，或 AUTH_ADMIN_TOKEN 走 Authorization: Bearer／body.token）
// body: { email?: string | null, role: string }
// 返回: { success:true, code, link, email, role, expires }

const ALLOWED_ORIGINS = [
  'https://www.kaiyuanguji.com',
  'https://kaiyuanguji.com','https://www.openguji.com','https://openguji.com',
  'https://open-guji.github.io',
  'http://localhost:3000',
  'http://localhost:5173',
];
// 谁有由用户在 /admin/members 指定；对 reviewer/editor/admin 三者行为无影响。
const ALLOWED_ROLES = ['reader', 'reviewer', 'editor', 'admin'];
const INVITE_TTL_SECONDS = 7 * 24 * 3600;

function getCorsHeaders(request) {
  const origin = request.headers.get('origin') || '';
  const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return { 'Access-Control-Allow-Origin': corsOrigin, 'Content-Type': 'application/json' };
}
function getAdminToken(context) {
  if (context && context.env && context.env.AUTH_ADMIN_TOKEN) return context.env.AUTH_ADMIN_TOKEN;
  return (typeof AUTH_ADMIN_TOKEN !== 'undefined') ? AUTH_ADMIN_TOKEN : null;
}
function getJwtSecret(context) {
  if (context && context.env && context.env.AUTH_JWT_SECRET) return context.env.AUTH_JWT_SECRET;
  return (typeof AUTH_JWT_SECRET !== 'undefined') ? AUTH_JWT_SECRET : null;
}
function getKV(context) {
  if (context && context.env && context.env.AUTH_KV) return context.env.AUTH_KV;
  if (typeof AUTH_KV !== 'undefined') return AUTH_KV;
  return null;
}
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function getCookie(request, name) {
  const cookie = request.headers.get('cookie') || '';
  const m = cookie.match(new RegExp('(?:^|;\\s*)' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
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
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
async function hmacSign(data, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return b64urlEncode(new Uint8Array(sig));
}
async function verifyJWT(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const data = `${h}.${p}`;
  const expect = await hmacSign(data, secret);
  if (!constantTimeEqual(expect, s)) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch { return null; }
}
// H1：令牌的 tv 必须等于成员记录的 tokenVersion（join／改角色／删除时 +1）；
// 旧令牌没有 tv、旧记录没有 tokenVersion 的一律视为失效
function tokenVersionOk(payload, member) {
  const v = member && member.tokenVersion;
  return Number.isInteger(v) && v > 0 && !!payload && payload.tv === v;
}
async function checkAdmin(request, context) {
  // 1) 尝试 cookie + 成员表
  const jwtSecret = getJwtSecret(context);
  const session = getCookie(request, 'session');
  if (session && jwtSecret) {
    const payload = await verifyJWT(session, jwtSecret);
    if (payload && payload.sub) {
      const kv = getKV(context);
      if (kv) {
        const member = await kv.get(`member:${payload.sub}`, 'json');
        if (member && typeof member === 'object' && !member._deleted && member.role === 'admin' && tokenVersionOk(payload, member)) {
          return { ok: true, by: payload.sub };
        }
      }
    }
  }
  // 2) 尝试 AUTH_ADMIN_TOKEN (Bearer 或 body.token)
  const expected = getAdminToken(context);
  if (!expected) return { ok: false, status: 503, error: '服务未配置 AUTH_ADMIN_TOKEN' };
  // M1：只看 Authorization header，不认 ?token=（查询串会进访问日志／Referer）；body.token 在 POST handler 里查
  const given = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (given && constantTimeEqual(given, String(expected))) return { ok: true, by: 'admin_token' };
  // 也允许 body.token（在 POST handler 里额外检查）
  return { ok: false, status: 401, error: '未授权' };
}

function genInviteCode() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return b64urlEncode(bytes); // 22 字符，128 bit
}
async function hashCode(code, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(code));
  const arr = new Uint8Array(sig);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequestPost(context) {
  const headers = getCorsHeaders(context.request);
  try {
    const kv = getKV(context);
    if (!kv) return new Response(JSON.stringify({ success: false, error: 'KV 未绑定' }), { status: 503, headers });
    const jwtSecret = getJwtSecret(context);
    if (!jwtSecret) return new Response(JSON.stringify({ success: false, error: '服务未配置 AUTH_JWT_SECRET' }), { status: 503, headers });

    // 鉴权：先看 cookie，其次看 Authorization header / body.token
    let auth = await checkAdmin(context.request, context);
    let body = {};
    try { body = await context.request.json(); } catch { body = {}; }
    if (!auth.ok) {
      const expected = getAdminToken(context);
      const bodyToken = body.token || '';
      if (expected && bodyToken && constantTimeEqual(bodyToken, String(expected))) {
        auth = { ok: true, by: 'admin_token_body' };
      }
    }
    if (!auth.ok) return new Response(JSON.stringify({ success: false, error: auth.error }), { status: auth.status, headers });

    const emailRaw = body.email != null ? String(body.email).trim().toLowerCase() : null;
    const email = emailRaw && emailRaw.length > 0 ? emailRaw : null;
    const role = String(body.role || '').trim();
    if (!ALLOWED_ROLES.includes(role)) {
      return new Response(JSON.stringify({ success: false, error: `role 必须为 ${ALLOWED_ROLES.join('/')}` }), { status: 400, headers });
    }
    if (email !== null) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return new Response(JSON.stringify({ success: false, error: '邮箱格式不正确' }), { status: 400, headers });
      }
    }
    if (role === 'admin' && !email) {
      return new Response(JSON.stringify({ success: false, error: 'admin 邀请必须绑定邮箱' }), { status: 400, headers });
    }

    const code = genInviteCode();
    const hash = await hashCode(code, jwtSecret);
    const now = Math.floor(Date.now() / 1000);
    const record = {
      email, role, expires: now + INVITE_TTL_SECONDS,
      createdBy: auth.by || 'admin', createdAt: now, usedAt: null,
    };
    await kv.put(`invite:${hash}`, JSON.stringify(record));

    const link = `https://www.openguji.com/join?c=${code}`;
    return new Response(JSON.stringify({ success: true, code, link, email, role, expires: record.expires }), { status: 200, headers });
  } catch (e) {
    console.error('invite error', e);
    const headers2 = getCorsHeaders(context.request);
    return new Response(JSON.stringify({ success: false, error: e.message || '生成失败' }), { status: 500, headers: headers2 });
  }
}

export function onRequestOptions(context) {
  const origin = context.request.headers.get('origin') || '';
  const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    },
  });
}
