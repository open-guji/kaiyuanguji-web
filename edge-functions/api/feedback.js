// 用户反馈端点（EdgeOne Pages Function）
//
// 三条路，鉴权口径**故意不同**：
//   POST（提交反馈）      公开 —— 读者必须能匿名提
//   GET （列出反馈）      公开 —— 站内反馈 tab 靠它渲染；记录里只有
//                        type/content/pageUrl/resourceId，没有 IP、没有 UA
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
// EdgeOne Pages 将环境变量和 KV 绑定注入为全局变量
function getMode() {
  return (typeof FEEDBACK_MODE !== 'undefined' && FEEDBACK_MODE === 'github') ? 'github' : 'kv';
}

function getAdminToken() {
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
function checkAdminAuth(given) {
  const expected = getAdminToken();
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

function getKV() {
  return (typeof FEEDBACK_KV !== 'undefined') ? FEEDBACK_KV : null;
}

function getGithubToken() {
  return (typeof GITHUB_TOKEN !== 'undefined') ? GITHUB_TOKEN : null;
}

// --- KV 模式 ---

async function kvPost(kv, type, content, pageUrl, resourceId) {
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
  await kv.put(id, JSON.stringify(record));
  return { id };
}

async function kvGet(kv, limit, cursor, resourceId) {
  const listOpts = { prefix: 'fb_', limit: resourceId ? 256 : limit };
  if (cursor && !resourceId) listOpts.cursor = cursor;
  const listResult = await kv.list(listOpts);
  const keys = listResult.keys || [];

  const items = [];
  for (const key of keys) {
    const val = await kv.get(key.key, 'json');
    if (val) {
      if (resourceId && val.resourceId !== resourceId) continue;
      items.push(val);
    }
  }
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return {
    items: resourceId ? items : items.slice(0, limit),
    cursor: resourceId ? '' : (listResult.cursor || ''),
    hasMore: resourceId ? false : !listResult.complete,
  };
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

async function kvPatch(kv, id, status, reply) {
  const record = await kv.get(id, 'json');
  if (!record) return null;
  if (status) record.status = status;
  if (reply !== undefined) record.reply = reply;
  record.updatedAt = new Date().toISOString();
  await kv.put(id, JSON.stringify(record));
  return record;
}

// --- 请求处理 ---

export async function onRequestPost(context) {
  const headers = getCorsHeaders(context.request);

  try {
    const body = await context.request.json();

    // action: "update" → 更新反馈状态/回复（替代 PATCH）
    if (body.action === 'update') {
      const auth = checkAdminAuth(body.token);
      if (!auth.ok) {
        return new Response(JSON.stringify({ success: false, error: auth.error }), {
          status: auth.status, headers,
        });
      }
      const { id, status, reply } = body;
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
      const kv = getKV();
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
    }

    // 默认：提交新反馈
    const { type, content, pageUrl, resourceId } = body;

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

    const mode = getMode();
    let result;

    if (mode === 'github') {
      const ghToken = getGithubToken();
      if (!ghToken) {
        return new Response(JSON.stringify({ success: false, error: '服务配置错误：GITHUB_TOKEN 未设置' }), {
          status: 500, headers,
        });
      }
      result = await githubPost(ghToken, type, content, pageUrl);
    } else {
      const kv = getKV();
      if (!kv) {
        return new Response(JSON.stringify({ success: false, error: '服务配置错误：KV 未绑定' }), {
          status: 500, headers,
        });
      }
      result = await kvPost(kv, type, content, pageUrl, resourceId);
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

    const mode = getMode();
    let result;

    if (mode === 'github') {
      const ghToken = getGithubToken();
      if (!ghToken) {
        return new Response(JSON.stringify({ success: false, error: '服务配置错误：GITHUB_TOKEN 未设置' }), {
          status: 500, headers,
        });
      }
      result = await githubGet(ghToken, limit);
    } else {
      const kv = getKV();
      if (!kv) {
        return new Response(JSON.stringify({ success: false, error: '服务配置错误：KV 未绑定' }), {
          status: 500, headers,
        });
      }
      result = await kvGet(kv, limit, cursor, resourceId);
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

    const kv = getKV();
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
