// 轻量前端错误自收端点（EdgeOne Pages Function）
// 前端 POST 上报错误 → 写入 ERROR_KV（带 TTL 自动过期）；管理端凭成员 cookie 或 Authorization: Bearer 查询。
// 与 feedback.js 同模式：KV 经全局变量绑定，环境变量经全局变量注入。
//
// 绑定/配置（EdgeOne Pages 控制台）：
//   - KV namespace 绑定为全局变量  ERROR_KV
//   - 环境变量  ERROR_VIEW_TOKEN  —— 读侧与管理侧鉴权（错误日志含 stack/IP，不公开）
//     **没配这个变量，读接口与 update 一律拒绝（503）**，见下面 checkViewAuth 的注释。
//     只有 POST 上报是公开的——那是前端必须能匿名调的。

const ALLOWED_ORIGINS = [
  'https://www.kaiyuanguji.com',
  'https://kaiyuanguji.com',
  'https://open-guji.github.io',
  'http://localhost:3000',
  'http://localhost:5173',
];

const RECORD_TTL_SECONDS = 30 * 24 * 3600; // 30 天后自动过期，避免 KV 无限增长
const MAX_MESSAGE = 1000;
const MAX_STACK = 4000;
const ALLOWED_KINDS = ['js', 'unhandledrejection', 'fetch', 'resource', 'react'];

function getCorsHeaders(request) {
  const origin = request.headers.get('origin') || '';
  const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': corsOrigin,
    'Content-Type': 'application/json',
  };
}

// EdgeOne Pages Functions 的环境变量/绑定既可能挂在 context.env 上，也可能被注入为
// 全局标识符——两条路都试，谁读到用谁。2026-09-22 实测：KV 绑定走全局变量能读到，
// 但环境变量（ERROR_VIEW_TOKEN／FEEDBACK_ADMIN_TOKEN）走全局变量读不到，需要 context.env。
function getKV(context) {
  if (context && context.env && context.env.ERROR_KV) return context.env.ERROR_KV;
  return (typeof ERROR_KV !== 'undefined') ? ERROR_KV : null;
}

function getViewToken(context) {
  if (context && context.env && context.env.ERROR_VIEW_TOKEN) return context.env.ERROR_VIEW_TOKEN;
  return (typeof ERROR_VIEW_TOKEN !== 'undefined') ? ERROR_VIEW_TOKEN : null;
}

/**
 * 读侧 / 管理侧鉴权。**必须 fail-closed。**
 *
 * 2026-09-14 实测出的事故：这里原先两处都写作
 *
 *     const token = getViewToken();
 *     if (token && given !== token) { 401 }
 *
 * 线上 ERROR_VIEW_TOKEN 从未配置 ⇒ token 为 null ⇒ 整个条件不成立 ⇒ 鉴权整段跳过。
 * 结果：312 条记录（其中 310 条含服务端从 request.eo 取的真实访客 IP 与地理，
 * 另有 stack、pageUrl、UA）不带任何凭证即可读，且已如此四个月。
 * 本文件开头的注释写的正是「含 stack/IP，不公开」——**本意就要拦，是配置没跟上**。
 *
 * 教训不在于少配了一个变量，而在于这个写法把「没配置」当成了「不用配置」。
 * 现在缺配置就回 503：坏得看得见，比默默敞着强。
 */
function checkViewAuth(given, context) {
  const expected = getViewToken(context);
  if (!expected) {
    return { ok: false, status: 503, error: '服务未配置 ERROR_VIEW_TOKEN，查询与管理接口一律拒绝' };
  }
  if (typeof given !== 'string' || !constantTimeEqual(given, String(expected))) {
    return { ok: false, status: 401, error: '未授权' };
  }
  return { ok: true };
}

/** 定长比较：不因首字符对不上就提前返回。（长度本身仍可被测出，不是密码学级别，够用。） */
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// --- auth 双轨：共享 token 或 member cookie（v3 邀请体系） ---
function getJwtSecret(context) {
  if (context && context.env && context.env.AUTH_JWT_SECRET) return context.env.AUTH_JWT_SECRET;
  return (typeof AUTH_JWT_SECRET !== 'undefined') ? AUTH_JWT_SECRET : null;
}
function getAuthKV(context) {
  // 成员表只认 AUTH_KV，不回落到 ERROR_KV / FEEDBACK_KV（与 auth/* 端点同一份成员表）
  if (context && context.env && context.env.AUTH_KV) return context.env.AUTH_KV;
  return (typeof AUTH_KV !== 'undefined') ? AUTH_KV : null;
}
function getCookie(request, name) {
  const c = request.headers.get('cookie') || '';
  const m = c.match(new RegExp('(?:^|;\\s*)' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '=([^;]*)'));
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
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) arr[i] = bin.charCodeAt(i);
  return arr;
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
// H1（SEC overview#134）：令牌的 tv 必须等于成员记录的 tokenVersion（join／改角色／删除时 +1）。
// 旧令牌没有 tv、旧记录没有 tokenVersion 的一律视为失效。
function tokenVersionOk(payload, member) {
  const v = member && member.tokenVersion;
  return Number.isInteger(v) && v > 0 && !!payload && payload.tv === v;
}
/** Authorization: Bearer <token>；没带返回 undefined。M1：不再认 ?token= 查询串（会进访问日志／Referer）。 */
function bearerToken(request) {
  const h = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  return h || undefined;
}
async function checkMemberCookie(request, context, allowedRoles) {
  const secret = getJwtSecret(context);
  const token = getCookie(request, 'session');
  if (!secret || !token) return null;
  const payload = await verifyJWT(token, secret);
  if (!payload || !payload.sub) return null;
  const kv = getAuthKV(context);
  if (!kv) return null;
  let member = null;
  try { member = await kv.get(`member:${payload.sub}`, 'json'); } catch { return null; }
  if (!member || typeof member !== 'object' || member._deleted || !member.role) return null;
  if (!tokenVersionOk(payload, member)) return null;
  if (allowedRoles && !allowedRoles.includes(member.role)) return null;
  return member;
}

function generateId() {
  return `err_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function clip(s, n) {
  if (typeof s !== 'string') return '';
  return s.length > n ? s.slice(0, n) : s;
}

// 真实客户端 IP / 地理：前端拿不到。EdgeOne Pages Functions 把客户端信息挂在
// request.eo 上（request.eo.clientIp + request.eo.geo），header 作兜底。
function getClientMeta(request) {
  const eo = request.eo || {};
  const geo = eo.geo || {};
  const h = request.headers;
  const xff = h.get('x-forwarded-for') || '';
  const ip =
    eo.clientIp ||
    h.get('eo-client-ip') ||
    (xff ? xff.split(',')[0].trim() : '') ||
    '';
  const geoStr = [
    geo.countryName || geo.countryCodeAlpha2 || geo.country,
    geo.regionName || geo.region || geo.cityName,
  ].filter(Boolean).join('/');
  return { ip, geo: geoStr };
}

// --- 上报：写入一条错误记录 ---
export async function onRequestPost(context) {
  const headers = getCorsHeaders(context.request);

  try {
    const kv = getKV(context);
    if (!kv) {
      return new Response(JSON.stringify({ success: false, error: 'ERROR_KV 未绑定' }), {
        status: 500, headers,
      });
    }

    const body = await context.request.json();

    // action: 'update' → 标记处理状态（管理操作，需 token 或 member cookie；与公开上报区分）
    if (body.action === 'update') {
      let auth = checkViewAuth(body.token, context);
      if (!auth.ok) {
        const member = await checkMemberCookie(context.request, context, ['reviewer', 'editor', 'admin']);
        if (member) auth = { ok: true };
      }
      if (!auth.ok) {
        return new Response(JSON.stringify({ success: false, error: auth.error }), { status: auth.status, headers });
      }
      if (!body.id || !/^err_/.test(body.id)) {
        return new Response(JSON.stringify({ success: false, error: '无效的 id' }), { status: 400, headers });
      }
      if (!['open', 'resolved'].includes(body.state)) {
        return new Response(JSON.stringify({ success: false, error: '无效的 state' }), { status: 400, headers });
      }
      const rec = await kv.get(body.id, 'json');
      if (!rec) {
        return new Response(JSON.stringify({ success: false, error: '记录不存在' }), { status: 404, headers });
      }
      rec.state = body.state;
      rec.updatedAt = new Date().toISOString();
      await kv.put(body.id, JSON.stringify(rec), { expirationTtl: RECORD_TTL_SECONDS });
      return new Response(JSON.stringify({ success: true, item: rec }), { status: 200, headers });
    }

    const message = clip(body.message, MAX_MESSAGE);
    if (!message) {
      return new Response(JSON.stringify({ success: false, error: 'message 不能为空' }), {
        status: 400, headers,
      });
    }

    const { ip, geo } = getClientMeta(context.request);
    const kind = ALLOWED_KINDS.includes(body.kind) ? body.kind : 'js';
    const id = generateId();
    const record = {
      id,
      kind,                                   // js | unhandledrejection | fetch | resource | react
      message,
      stack: clip(body.stack, MAX_STACK),
      pageUrl: clip(body.pageUrl, 500),
      source: clip(body.source, 300),         // file:line:col（JS 错误）
      resource: clip(body.resource, 300),     // fetch 失败的资源 id/url
      status: typeof body.status === 'number' ? body.status : null,
      state: 'open',                          // 处理状态：open | resolved（与上面 HTTP status 区分）
      release: clip(body.release, 60),        // 构建版本（version.json commit），便于归因
      ua: clip(context.request.headers.get('user-agent'), 300),
      clientIp: ip,                           // 服务端取，可信
      geo,
      createdAt: new Date().toISOString(),
    };

    // TTL 为增强项：EdgeOne KV 若不支持 options 形参会忽略，不影响写入（见 task 3.A）
    await kv.put(id, JSON.stringify(record), { expirationTtl: RECORD_TTL_SECONDS });

    return new Response(JSON.stringify({ success: true, id }), { status: 200, headers });
  } catch (e) {
    console.error('track-error POST error:', e);
    return new Response(JSON.stringify({ success: false, error: e.message || '上报失败' }), {
      status: 500, headers,
    });
  }
}

// --- 查询：管理端凭成员 cookie 或 Bearer token 列出最近错误 ---
export async function onRequestGet(context) {
  const headers = getCorsHeaders(context.request);

  try {
    const url = new URL(context.request.url);

    // MON：监控用的计数汇总（?summary=1&window=1h）。只要共享 token（监控跑在 CI 里没有 cookie），
    // 只返回计数与前 5 种错误的消息摘要——不返回 IP、地理、stack、UA、pageUrl
    if (url.searchParams.get('summary') === '1') {
      return summaryResponse(context, url, headers);
    }

    // 鉴权：共享 token（Authorization: Bearer）或 member cookie 双轨
    let auth = checkViewAuth(bearerToken(context.request), context);
    let viaRole = auth.ok ? 'token' : null; // 走哪一路通过的：token / 成员角色
    if (!auth.ok) {
      const member = await checkMemberCookie(context.request, context, ['reviewer', 'editor', 'admin']);
      if (member) { auth = { ok: true }; viaRole = member.role; }
    }
    if (!auth.ok) {
      return new Response(JSON.stringify({ success: false, error: auth.error }), {
        status: auth.status, headers,
      });
    }

    // 调试：?debug=eo 返回 request.eo 原始结构 + headers，用于确认 IP/地理字段名（token 保护）
    // 只给共享 token 或 admin：它回显全部请求头与 request.eo 原始结构，reviewer/editor 看错误列表就够了
    if (url.searchParams.get('debug') === 'eo') {
      if (viaRole !== 'token' && viaRole !== 'admin') {
        return new Response(JSON.stringify({ success: false, error: 'debug=eo 仅限共享 token 或 admin' }), {
          status: 403, headers,
        });
      }
      return new Response(JSON.stringify({
        eo: context.request.eo || null,
        headers: Object.fromEntries(context.request.headers),
      }, null, 2), { status: 200, headers });
    }

    const kv = getKV(context);
    if (!kv) {
      return new Response(JSON.stringify({ success: false, error: 'ERROR_KV 未绑定' }), {
        status: 500, headers,
      });
    }

    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
    const cursor = url.searchParams.get('cursor') || '';
    const kindFilter = url.searchParams.get('kind') || '';

    const listOpts = { prefix: 'err_', limit };
    if (cursor) listOpts.cursor = cursor;
    const listResult = await kv.list(listOpts);
    const keys = listResult.keys || [];

    // 2026-09-14 实测：逐条 await kv.get 导致全量 312 条取数 110s。
    // EdgeOne 单次请求内 KV 并发可能限流，故分块并发（每批 20），兼顾速度与限流风险。
    // 单条 kv.get 抛错（如限流）不让整页 500：用 allSettled 丢弃失败条，控制台可从日志观测。
    const BATCH_SIZE = 20;
    const items = [];
    for (let i = 0; i < keys.length; i += BATCH_SIZE) {
      const batch = keys.slice(i, i + BATCH_SIZE);
      const settled = await Promise.allSettled(batch.map((k) => kv.get(k.key, 'json')));
      for (const r of settled) {
        if (r.status !== 'fulfilled') continue;
        const val = r.value;
        if (val) {
          if (kindFilter && val.kind !== kindFilter) continue;
          items.push(val);
        }
      }
    }
    items.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

    return new Response(JSON.stringify({
      success: true,
      items,
      cursor: listResult.cursor || '',
      hasMore: !listResult.complete,
    }), { status: 200, headers });
  } catch (e) {
    console.error('track-error GET error:', e);
    return new Response(JSON.stringify({ success: false, error: e.message || '查询失败' }), {
      status: 500, headers,
    });
  }
}

/**
 * 监控汇总。key 是 `err_<13 位毫秒>_…`：计数只看 key 名，不取值；
 * 只有落在窗口内的至多 SUMMARY_MAX_GET 条才取值，用来归并「前 5 种错误」。
 * 摘要只取 kind + message 前 120 字，message 里若混进邮箱／长数字串一并打码。
 */
const SUMMARY_MAX_GET = 200;
async function summaryResponse(context, url, headers) {
  const auth = checkViewAuth(bearerToken(context.request), context);
  if (!auth.ok) {
    return new Response(JSON.stringify({ success: false, error: auth.error }), { status: auth.status, headers });
  }
  const kv = getKV(context);
  if (!kv) {
    return new Response(JSON.stringify({ success: false, error: 'ERROR_KV 未绑定' }), { status: 500, headers });
  }
  const n = parseInt(String(url.searchParams.get('window') || '1').replace(/h$/i, ''), 10);
  const windowHours = Number.isFinite(n) && n >= 1 && n <= 24 ? n : 1;
  const now = Date.now();

  const names = [];
  let cursor = '';
  for (let i = 0; i < 100; i += 1) {
    const opts = { prefix: 'err_', limit: 256 };
    if (cursor) opts.cursor = cursor;
    const r = await kv.list(opts);
    for (const k of r.keys || []) names.push(k.key);
    if (r.complete || !r.cursor) break;
    cursor = r.cursor;
  }

  const inWindow = [];
  let count24h = 0;
  for (const name of names) {
    const m = /^err_(\d{13})_/.exec(name);
    if (!m) continue;
    const age = now - Number(m[1]);
    if (age < 0) continue;
    if (age <= windowHours * 3600000) inWindow.push(name);
    if (age <= 24 * 3600000) count24h += 1;
  }

  const sample = inWindow.sort().reverse().slice(0, SUMMARY_MAX_GET);
  const groups = new Map();
  for (let i = 0; i < sample.length; i += 20) {
    const settled = await Promise.allSettled(sample.slice(i, i + 20).map((k) => kv.get(k, 'json')));
    for (const r of settled) {
      if (r.status !== 'fulfilled' || !r.value) continue;
      const key = `${r.value.kind || 'js'}|${redact(clip(r.value.message, 120))}`;
      groups.set(key, (groups.get(key) || 0) + 1);
    }
  }
  const top = [...groups.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([k, count]) => { const i = k.indexOf('|'); return { kind: k.slice(0, i), message: k.slice(i + 1), count }; });

  return new Response(JSON.stringify({
    success: true,
    windowHours,
    count: inWindow.length,
    count24h,
    avgPerHour24h: Math.round((count24h / 24) * 100) / 100,
    sampled: sample.length,
    top,
    now: new Date(now).toISOString(),
  }), { status: 200, headers: { ...headers, 'Cache-Control': 'no-store' } });
}

function redact(s) {
  return String(s)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '***@***')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '*.*.*.*')
    .replace(/\d{7,}/g, '***');
}

export function onRequestOptions(context) {
  const origin = context.request.headers.get('origin') || '';
  const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    },
  });
}
