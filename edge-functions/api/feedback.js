// 用户反馈端点（EdgeOne Pages Function）
//
// 三条路，鉴权口径**故意不同**：
//   POST（提交反馈）      公开 —— 读者必须能匿名提
//   GET （列出反馈）      公开 —— 站内反馈 tab 靠它渲染；记录里只有
//                        type/content/pageUrl/resourceId，没有 IP、没有 UA。
//                        **公开读剔除**：已隐藏的（visibility=hidden）、测试数据（test=true）、
//                        以及 contact 字段（读者留的联系方式，只给站方看）。
//                        带管理凭证（token 或成员 cookie）读时返回全量、原样（/admin/feedback 用）。
//   POST action:'update' 与 PATCH（改状态／写回复）
//                        **必须带 FEEDBACK_ADMIN_TOKEN**，见 checkAdminAuth
//
// 绑定/配置（EdgeOne Pages 控制台）：
//   - KV namespace 绑定为全局变量  FEEDBACK_KV
//   - 环境变量  FEEDBACK_MODE       "kv"（默认）| "github"
//   - 环境变量  GITHUB_TOKEN        FEEDBACK_MODE=github 时转发用
//   - 环境变量  FEEDBACK_ADMIN_TOKEN  管理侧鉴权。**没配就一律拒绝（503）**

const ALLOWED_ORIGINS = [
  'https://www.kaiyuanguji.com',
  'https://kaiyuanguji.com',
  'https://open-guji.github.io',
  'http://localhost:3000',
  'http://localhost:5173',
];

function getCorsHeaders(request) {
  const origin = request.headers.get('origin') || '';
  const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': corsOrigin,
    'Content-Type': 'application/json',
  };
}

function generateId() {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 6);
  return `fb_${ts}_${rand}`;
}

// 存储模式：环境变量 FEEDBACK_MODE = "kv" | "github"，默认 "kv"
// EdgeOne Pages 的环境变量/绑定既可能挂在 context.env 上，也可能被注入为全局标识符——
// 两条路都试，谁读到用谁。2026-09-22 实测（见 track-error.js 同款修复）：KV 绑定走全局
// 变量能读到，但环境变量走全局变量读不到，需要 context.env。
function getMode(context) {
  const v = (context && context.env && context.env.FEEDBACK_MODE)
    || (typeof FEEDBACK_MODE !== 'undefined' ? FEEDBACK_MODE : undefined);
  return v === 'github' ? 'github' : 'kv';
}

function getAdminToken(context) {
  if (context && context.env && context.env.FEEDBACK_ADMIN_TOKEN) return context.env.FEEDBACK_ADMIN_TOKEN;
  return (typeof FEEDBACK_ADMIN_TOKEN !== 'undefined') ? FEEDBACK_ADMIN_TOKEN : null;
}

/**
 * 管理侧鉴权（改状态 / 写回复）。**必须 fail-closed。**
 *
 * 2026-09-14 实测出的洞：`POST {action:'update'}` 这条路**一点鉴权都没有**——
 * 不是「配置缺失时被跳过」，是压根没写检查。而：
 *   · `fb_` id 从公开的 GET 里就能枚举；
 *   · `reply` 会被 book-index-ui 当作站方回复渲染到反馈列表上。
 * 合起来就是：任何人一条 curl 就能以站方口吻说话，并把任何反馈标成「已解决」。
 *
 * 读与提交仍然公开——那两条是这个功能存在的理由。只有「代表站方说话」要凭证。
 */
function checkAdminAuth(given, context) {
  const expected = getAdminToken(context);
  if (!expected) {
    return { ok: false, status: 503, error: '服务未配置 FEEDBACK_ADMIN_TOKEN，管理接口一律拒绝' };
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

function getKV(context) {
  if (context && context.env && context.env.FEEDBACK_KV) return context.env.FEEDBACK_KV;
  return (typeof FEEDBACK_KV !== 'undefined') ? FEEDBACK_KV : null;
}
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
  if (allowedRoles && !allowedRoles.includes(member.role)) return null;
  return member;
}

function getGithubToken(context) {
  if (context && context.env && context.env.GITHUB_TOKEN) return context.env.GITHUB_TOKEN;
  return (typeof GITHUB_TOKEN !== 'undefined') ? GITHUB_TOKEN : null;
}

// --- KV 模式 ---

async function kvPost(kv, type, content, pageUrl, resourceId, contact, test) {
  const id = generateId();
  const record = {
    id,
    type,
    content: content.trim(),
    pageUrl: pageUrl || '',
    resourceId: resourceId || '',
    createdAt: new Date().toISOString(),
    status: 'pending',
    reply: '',
  };
  if (contact) record.contact = contact;
  if (test) record.test = true;
  await kv.put(id, JSON.stringify(record));
  return { id };
}

/**
 * 公开读要剔除的记录与字段（见文件头）。旧记录没有 visibility 字段，按公开处理。
 */
function isPubliclyVisible(rec) {
  return rec && rec.visibility !== 'hidden' && rec.test !== true;
}
function toPublic(rec) {
  const { contact, ...rest } = rec; // eslint-disable-line no-unused-vars
  return rest;
}

async function listAllKeys(kv) {
  const names = [];
  let cursor = '';
  for (let i = 0; i < 100; i += 1) {
    const opts = { prefix: 'fb_', limit: 256 };
    if (cursor) opts.cursor = cursor;
    const r = await kv.list(opts);
    for (const k of r.keys || []) names.push(k.key);
    if (r.complete || !r.cursor) break;
    cursor = r.cursor;
  }
  return names;
}

/**
 * 按时间倒序取反馈。
 *
 * 2026-09-24 查出的坑（G-23 A2）：KV 按 key 升序返回，key 是 `fb_<毫秒>_…`，
 * 旧写法 `kv.list({limit})` 取到的是**最旧**的一页，再在页内倒序——
 * 反馈一多，首页只剩最早那批；按 resourceId 过滤只扫前 256 个 key，更新的书页反馈直接看不见。
 * 现在先列全部 key（只是 key，便宜），按 key 倒序（毫秒位数固定，字典序即时间序），
 * 再从新往旧取值、过滤，够数即停。
 *
 * cursor 语义改为「上一页扫到的最后一个 key」，下一页从比它更旧的开始。
 *
 * 代价：每次读都列一遍全部 key；按 resourceId 过滤时最坏要读遍所有值。
 * 现在只有十几条，无所谓；到上千条再给 resourceId 建索引 key。
 */
async function kvGet(kv, limit, cursor, resourceId, full) {
  const names = (await listAllKeys(kv)).sort().reverse();
  let start = 0;
  if (cursor) {
    const idx = names.indexOf(cursor);
    start = idx >= 0 ? idx + 1 : names.findIndex((n) => n < cursor);
    if (start < 0) start = names.length;
  }

  const items = [];
  let i = start;
  const BATCH = 20;
  while (i < names.length && items.length < limit) {
    const batch = names.slice(i, i + BATCH);
    const vals = await Promise.all(batch.map((k) => kv.get(k, 'json').catch(() => null)));
    for (let j = 0; j < batch.length; j += 1) {
      i += 1;
      const val = vals[j];
      if (!val) continue;
      if (resourceId && val.resourceId !== resourceId) continue;
      if (!full && !isPubliclyVisible(val)) continue;
      items.push(full ? val : toPublic(val));
      if (items.length >= limit) break;
    }
  }

  // 游标取「最后扫过的一条」而非「最后返回的一条」：被过滤掉的也不必下一页再扫一遍
  const hasMore = i < names.length;
  return { items, cursor: hasMore ? names[i - 1] : '', hasMore };
}

// --- GitHub 模式 ---

async function githubPost(ghToken, type, content, pageUrl) {
  const labels = type === 'bug' ? ['反馈-错误'] : ['反馈-资源'];
  const title = type === 'bug'
    ? `[错误反馈] ${content.slice(0, 50)}`
    : `[资源建议] ${content.slice(0, 50)}`;
  const body = `${content}\n\n---\n来源页面: ${pageUrl || '未知'}\n提交时间: ${new Date().toISOString()}`;

  const res = await fetch('https://api.github.com/repos/open-guji/book-index-draft/issues', {
    method: 'POST',
    headers: {
      'Authorization': `token ${ghToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'kaiyuanguji-feedback',
    },
    body: JSON.stringify({ title, body, labels }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    console.error('GitHub API error:', res.status, errBody);
    throw new Error('GitHub Issue 创建失败');
  }

  const issue = await res.json();
  return { id: `issue_${issue.number}`, issueNumber: issue.number };
}

async function githubGet(ghToken, limit) {
  const res = await fetch(
    `https://api.github.com/repos/open-guji/book-index-draft/issues?labels=反馈-错误,反馈-资源&state=all&per_page=${limit}&sort=created&direction=desc`,
    {
      headers: {
        'Authorization': `token ${ghToken}`,
        'User-Agent': 'kaiyuanguji-feedback',
      },
    }
  );

  if (!res.ok) {
    throw new Error('GitHub API 查询失败');
  }

  const issues = await res.json();
  const items = issues.map(issue => ({
    id: `issue_${issue.number}`,
    type: issue.labels.some(l => l.name === '反馈-错误') ? 'bug' : 'resource',
    content: issue.body?.split('\n---\n')[0] || issue.title,
    createdAt: issue.created_at,
    status: issue.state === 'closed' ? 'resolved' : 'pending',
    reply: '',
  }));

  return { items, cursor: '', hasMore: false };
}

// --- KV PATCH ---

async function kvPatch(kv, id, status, reply, visibility, test) {
  const record = await kv.get(id, 'json');
  if (!record) return null;
  if (status) record.status = status;
  if (reply !== undefined) record.reply = reply;
  if (visibility) record.visibility = visibility;
  if (test !== undefined) record.test = test === true;
  record.updatedAt = new Date().toISOString();
  await kv.put(id, JSON.stringify(record));
  return record;
}

// --- 请求处理 ---

export async function onRequestPost(context) {
  const headers = getCorsHeaders(context.request);

  try {
    const body = await context.request.json();

    // action: "update" → 更新反馈状态/回复（替代 PATCH，双轨：token 或 member cookie）
    if (body.action === 'update') {
      let auth = checkAdminAuth(body.token, context);
      if (!auth.ok) {
        const member = await checkMemberCookie(context.request, context, ['reviewer', 'editor', 'admin']);
        if (member) auth = { ok: true };
      }
      if (!auth.ok) {
        return new Response(JSON.stringify({ success: false, error: auth.error }), {
          status: auth.status, headers,
        });
      }
      const { id, status, reply, visibility, test } = body;
      if (!id || !id.startsWith('fb_')) {
        return new Response(JSON.stringify({ success: false, error: '无效的反馈 ID' }), {
          status: 400, headers,
        });
      }
      if (status && !['pending', 'resolved'].includes(status)) {
        return new Response(JSON.stringify({ success: false, error: '无效的状态值' }), {
          status: 400, headers,
        });
      }
      if (visibility !== undefined && !['public', 'hidden'].includes(visibility)) {
        return new Response(JSON.stringify({ success: false, error: '无效的可见性' }), {
          status: 400, headers,
        });
      }
      if (test !== undefined && typeof test !== 'boolean') {
        return new Response(JSON.stringify({ success: false, error: 'test 须为布尔值' }), {
          status: 400, headers,
        });
      }
      const kv = getKV(context);
      if (!kv) {
        return new Response(JSON.stringify({ success: false, error: 'KV 未绑定' }), {
          status: 500, headers,
        });
      }
      const updated = await kvPatch(kv, id, status, reply, visibility, test);
      if (!updated) {
        return new Response(JSON.stringify({ success: false, error: '反馈不存在' }), {
          status: 404, headers,
        });
      }
      return new Response(JSON.stringify({ success: true, item: updated }), {
        status: 200, headers,
      });
    }

    // 默认：提交新反馈
    const { type, content, pageUrl, resourceId } = body;
    // 联系方式：选填，只给站方看（公开读剔除）。只做长度与去空白，不校验格式——读者可能留微信号
    const contact = typeof body.contact === 'string' ? body.contact.trim().slice(0, 200) : '';
    // 测试数据：本地开发（Origin 是 localhost，FeedbackTab 等在 localhost 下直连生产）或探针显式带 test:true。
    // 照常落库（便于排查），但公开读看不到（G-23 A3）
    const origin = context.request.headers.get('origin') || '';
    const test = body.test === true || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

    if (!['bug', 'resource'].includes(type)) {
      return new Response(JSON.stringify({ success: false, error: '无效的反馈类型' }), {
        status: 400, headers,
      });
    }
    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return new Response(JSON.stringify({ success: false, error: '反馈内容不能为空' }), {
        status: 400, headers,
      });
    }
    if (content.length > 2000) {
      return new Response(JSON.stringify({ success: false, error: '反馈内容不能超过2000字' }), {
        status: 400, headers,
      });
    }

    const mode = getMode(context);
    let result;

    if (mode === 'github') {
      const ghToken = getGithubToken(context);
      if (!ghToken) {
        return new Response(JSON.stringify({ success: false, error: '服务配置错误：GITHUB_TOKEN 未设置' }), {
          status: 500, headers,
        });
      }
      result = await githubPost(ghToken, type, content, pageUrl);
    } else {
      const kv = getKV(context);
      if (!kv) {
        return new Response(JSON.stringify({ success: false, error: '服务配置错误：KV 未绑定' }), {
          status: 500, headers,
        });
      }
      result = await kvPost(kv, type, content, pageUrl, resourceId, contact, test);
    }

    return new Response(JSON.stringify({ success: true, ...result }), {
      status: 200, headers,
    });
  } catch (e) {
    console.error('Feedback POST error:', e);
    return new Response(JSON.stringify({ success: false, error: e.message || '服务器错误' }), {
      status: 500, headers,
    });
  }
}

export async function onRequestGet(context) {
  const headers = getCorsHeaders(context.request);

  try {
    const url = new URL(context.request.url);
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), 100);
    const cursor = url.searchParams.get('cursor') || '';
    const resourceId = url.searchParams.get('resourceId') || '';
    // 管理读：带 token（?token=）或成员 cookie 时返回全量原样；否则按公开规则过滤。
    // 没凭证不是错误，照常返回公开结果（不回 401，站内反馈 tab 靠它）
    let full = checkAdminAuth(url.searchParams.get('token') || undefined, context).ok;
    if (!full) full = !!(await checkMemberCookie(context.request, context, ['reviewer', 'editor', 'admin']));

    const mode = getMode(context);
    let result;

    if (mode === 'github') {
      const ghToken = getGithubToken(context);
      if (!ghToken) {
        return new Response(JSON.stringify({ success: false, error: '服务配置错误：GITHUB_TOKEN 未设置' }), {
          status: 500, headers,
        });
      }
      result = await githubGet(ghToken, limit);
    } else {
      const kv = getKV(context);
      if (!kv) {
        return new Response(JSON.stringify({ success: false, error: '服务配置错误：KV 未绑定' }), {
          status: 500, headers,
        });
      }
      result = await kvGet(kv, limit, cursor, resourceId, full);
    }

    return new Response(JSON.stringify({ success: true, ...result }), {
      status: 200, headers,
    });
  } catch (e) {
    console.error('Feedback GET error:', e);
    return new Response(JSON.stringify({ success: false, error: e.message || '查询失败' }), {
      status: 500, headers,
    });
  }
}

/**
 * EdgeOne 实测不路由 PATCH（所以上面的 POST action:'update' 才是活着的那条路）。
 * 但「现在到不了」不等于「以后也到不了」——平台哪天支持了，这里就是第二个入口。
 * 故同样上闸，且与 action:'update' 用同一个 checkAdminAuth。
 */
export async function onRequestPatch(context) {
  const headers = getCorsHeaders(context.request);

  try {
    const url = new URL(context.request.url);

    const body0 = await context.request.clone().json().catch(() => ({}));
    const auth = checkAdminAuth(
      body0.token ?? (context.request.headers.get('authorization') || '').replace(/^Bearer /, ''),
      context,
    );
    if (!auth.ok) {
      return new Response(JSON.stringify({ success: false, error: auth.error }), {
        status: auth.status, headers,
      });
    }

    // 路径：/api/feedback/:id
    const id = url.pathname.split('/').pop();
    if (!id || !id.startsWith('fb_')) {
      return new Response(JSON.stringify({ success: false, error: '无效的反馈 ID' }), {
        status: 400, headers,
      });
    }

    const { status, reply } = await context.request.json();
    if (status && !['pending', 'resolved'].includes(status)) {
      return new Response(JSON.stringify({ success: false, error: '无效的状态值' }), {
        status: 400, headers,
      });
    }

    const kv = getKV(context);
    if (!kv) {
      return new Response(JSON.stringify({ success: false, error: 'KV 未绑定' }), {
        status: 500, headers,
      });
    }

    const updated = await kvPatch(kv, id, status, reply);
    if (!updated) {
      return new Response(JSON.stringify({ success: false, error: '反馈不存在' }), {
        status: 404, headers,
      });
    }

    return new Response(JSON.stringify({ success: true, item: updated }), {
      status: 200, headers,
    });
  } catch (e) {
    console.error('Feedback PATCH error:', e);
    return new Response(JSON.stringify({ success: false, error: e.message || '更新失败' }), {
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
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
}
