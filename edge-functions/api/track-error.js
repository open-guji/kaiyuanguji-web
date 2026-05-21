// 轻量前端错误自收端点（EdgeOne Pages Function）
// 前端 POST 上报错误 → 写入 ERROR_KV（带 TTL 自动过期）；管理端凭 token GET 查询。
// 与 feedback.js 同模式：KV 经全局变量绑定，环境变量经全局变量注入。
//
// 绑定/配置（EdgeOne Pages 控制台）：
//   - KV namespace 绑定为全局变量  ERROR_KV
//   - 环境变量  ERROR_VIEW_TOKEN  —— GET 查询鉴权（错误日志含 stack/IP，不公开）

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

function getKV() {
  return (typeof ERROR_KV !== 'undefined') ? ERROR_KV : null;
}

function getViewToken() {
  return (typeof ERROR_VIEW_TOKEN !== 'undefined') ? ERROR_VIEW_TOKEN : null;
}

function generateId() {
  return `err_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function clip(s, n) {
  if (typeof s !== 'string') return '';
  return s.length > n ? s.slice(0, n) : s;
}

// 真实客户端 IP / 地理：前端拿不到，从 EdgeOne 注入的请求头取，做多重 fallback。
// 注意：EdgeOne 实际 header 名以线上抓包为准，部署后用 task 3.A 校验后再定稿。
function getClientMeta(request) {
  const h = request.headers;
  const xff = h.get('x-forwarded-for') || '';
  const ip =
    h.get('eo-client-ip') ||
    h.get('eo-connecting-ip') ||
    (xff ? xff.split(',')[0].trim() : '') ||
    h.get('remote-host') ||
    '';
  const country = h.get('eo-ip-country') || h.get('eo-geo-country') || '';
  const region = h.get('eo-ip-region') || h.get('eo-geo-region') || '';
  return { ip, geo: [country, region].filter(Boolean).join('/') };
}

// --- 上报：写入一条错误记录 ---
export async function onRequestPost(context) {
  const headers = getCorsHeaders(context.request);

  try {
    const kv = getKV();
    if (!kv) {
      return new Response(JSON.stringify({ success: false, error: 'ERROR_KV 未绑定' }), {
        status: 500, headers,
      });
    }

    const body = await context.request.json();
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

// --- 查询：管理端凭 token 列出最近错误 ---
export async function onRequestGet(context) {
  const headers = getCorsHeaders(context.request);

  try {
    const url = new URL(context.request.url);

    // 鉴权：配置了 ERROR_VIEW_TOKEN 时强制校验
    const token = getViewToken();
    if (token && url.searchParams.get('token') !== token) {
      return new Response(JSON.stringify({ success: false, error: '未授权' }), {
        status: 401, headers,
      });
    }

    const kv = getKV();
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

    const items = [];
    for (const key of keys) {
      const val = await kv.get(key.key, 'json'); // 沿用 feedback.js：EdgeOne 返回 key.key
      if (val) {
        if (kindFilter && val.kind !== kindFilter) continue;
        items.push(val);
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

export function onRequestOptions(context) {
  const origin = context.request.headers.get('origin') || '';
  const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];

  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}
