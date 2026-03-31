const ALLOWED_ORIGINS = [
  'https://www.kaiyuanguji.com',
  'https://kaiyuanguji.com',
  'https://open-guji.github.io',
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
function getMode(env) {
  return env.FEEDBACK_MODE === 'github' ? 'github' : 'kv';
}

// --- KV 模式 ---

async function kvPost(kv, type, content, pageUrl) {
  const id = generateId();
  const record = {
    id,
    type,
    content: content.trim(),
    pageUrl: pageUrl || '',
    createdAt: new Date().toISOString(),
    status: 'pending',
    reply: '',
  };
  await kv.put(id, JSON.stringify(record));
  return { id };
}

async function kvGet(kv, limit, cursor) {
  const listResult = await kv.list({ prefix: 'fb_', limit, cursor: cursor || undefined });
  const keys = listResult.keys || [];

  const items = [];
  for (const key of keys) {
    const val = await kv.get(key.name, { type: 'json' });
    if (val) items.push(val);
  }
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return {
    items,
    cursor: listResult.cursor || '',
    hasMore: !listResult.complete,
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

// --- 请求处理 ---

export async function onRequestPost(context) {
  const headers = getCorsHeaders(context.request);

  try {
    const { type, content, pageUrl } = await context.request.json();

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

    const mode = getMode(context.env);
    let result;

    if (mode === 'github') {
      const ghToken = context.env.GITHUB_TOKEN;
      if (!ghToken) {
        return new Response(JSON.stringify({ success: false, error: '服务配置错误：GITHUB_TOKEN 未设置' }), {
          status: 500, headers,
        });
      }
      result = await githubPost(ghToken, type, content, pageUrl);
    } else {
      const kv = context.env.FEEDBACK_KV;
      if (!kv) {
        return new Response(JSON.stringify({ success: false, error: '服务配置错误：KV 未绑定' }), {
          status: 500, headers,
        });
      }
      result = await kvPost(kv, type, content, pageUrl);
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

    const mode = getMode(context.env);
    let result;

    if (mode === 'github') {
      const ghToken = context.env.GITHUB_TOKEN;
      if (!ghToken) {
        return new Response(JSON.stringify({ success: false, error: '服务配置错误：GITHUB_TOKEN 未设置' }), {
          status: 500, headers,
        });
      }
      result = await githubGet(ghToken, limit);
    } else {
      const kv = context.env.FEEDBACK_KV;
      if (!kv) {
        return new Response(JSON.stringify({ success: false, error: '服务配置错误：KV 未绑定' }), {
          status: 500, headers,
        });
      }
      result = await kvGet(kv, limit, cursor);
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
