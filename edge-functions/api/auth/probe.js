// Step 1 probe：验证 EdgeOne 边缘运行时能力（带 token 保护）
// 四项：crypto.subtle / crypto.getRandomValues / Set-Cookie / kv expirationTtl
// 鉴权：AUTH_ADMIN_TOKEN（context.env 或全局），Bearer header 或 ?token=
// 仅用于上线前一次验证，之后可删除或保留为 503

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

function getAdminToken(context) {
  if (context && context.env && context.env.AUTH_ADMIN_TOKEN) return context.env.AUTH_ADMIN_TOKEN;
  return (typeof AUTH_ADMIN_TOKEN !== 'undefined') ? AUTH_ADMIN_TOKEN : null;
}
function getJwtSecret(context) {
  if (context && context.env && context.env.AUTH_JWT_SECRET) return context.env.AUTH_JWT_SECRET;
  return (typeof AUTH_JWT_SECRET !== 'undefined') ? AUTH_JWT_SECRET : null;
}
function getKV(context) {
  // 尝试 AUTH_KV，其次复用已绑定的 ERROR_KV/FEEDBACK_KV 仅用于探测
  if (context && context.env) {
    if (context.env.AUTH_KV) return { kv: context.env.AUTH_KV, name: 'AUTH_KV(context.env)' };
    if (context.env.ERROR_KV) return { kv: context.env.ERROR_KV, name: 'ERROR_KV(context.env)' };
    if (context.env.FEEDBACK_KV) return { kv: context.env.FEEDBACK_KV, name: 'FEEDBACK_KV(context.env)' };
  }
  if (typeof AUTH_KV !== 'undefined') return { kv: AUTH_KV, name: 'AUTH_KV(global)' };
  if (typeof ERROR_KV !== 'undefined') return { kv: ERROR_KV, name: 'ERROR_KV(global)' };
  if (typeof FEEDBACK_KV !== 'undefined') return { kv: FEEDBACK_KV, name: 'FEEDBACK_KV(global)' };
  return null;
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function checkAuth(request, context) {
  const expected = getAdminToken(context);
  if (!expected) return { ok: false, status: 503, error: '服务未配置 AUTH_ADMIN_TOKEN' };
  const url = new URL(request.url);
  const given = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim()
    || url.searchParams.get('token')
    || '';
  if (!given || !constantTimeEqual(given, String(expected))) {
    return { ok: false, status: 401, error: '未授权' };
  }
  return { ok: true };
}

async function testSubtle() {
  try {
    if (!globalThis.crypto || !globalThis.crypto.subtle) return { pass: false, detail: 'crypto.subtle 不可用' };
    const key = await globalThis.crypto.subtle.importKey(
      'raw', new TextEncoder().encode('probe-key-32bytes-long-123456'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sig = await globalThis.crypto.subtle.sign('HMAC', key, new TextEncoder().encode('hello'));
    return { pass: sig.byteLength === 32, detail: `HMAC-SHA256 sig len ${sig.byteLength}` };
  } catch (e) {
    return { pass: false, detail: e.message || String(e) };
  }
}

function testGetRandomValues() {
  try {
    if (!globalThis.crypto || !globalThis.crypto.getRandomValues) return { pass: false, detail: 'crypto.getRandomValues 不可用' };
    const buf = new Uint8Array(22);
    globalThis.crypto.getRandomValues(buf);
    const hasEntropy = buf.some(b => b !== 0);
    return { pass: hasEntropy, detail: `getRandomValues 22B OK, sample ${buf[0]},${buf[1]},${buf[2]}` };
  } catch (e) {
    return { pass: false, detail: e.message || String(e) };
  }
}

async function testKvTtl(kvInfo) {
  if (!kvInfo) return { pass: false, detail: '无可用 KV 绑定（AUTH_KV/ERROR_KV/FEEDBACK_KV 均未绑定）' };
  try {
    const probeKey = `__probe_${Date.now()}_a`;
    // 尝试带 expirationTtl 的 put
    await kvInfo.kv.put(probeKey, JSON.stringify({ v: 1 }), { expirationTtl: 60 });
    const got = await kvInfo.kv.get(probeKey, 'json');
    if (!got) return { pass: false, detail: `${kvInfo.name} put/get 失败，读回 null（可能不支持 options）` };
    // 清理
    try { await kvInfo.kv.put(probeKey, JSON.stringify({ v: 1 }), { expirationTtl: 1 }); } catch (_) {}
    return { pass: true, detail: `${kvInfo.name} put/get OK（expirationTtl 未报错）` };
  } catch (e) {
    return { pass: false, detail: `${kvInfo.name} error: ${e.message || String(e)}` };
  }
}

export async function onRequestGet(context) {
  const headers = getCorsHeaders(context.request);
  const auth = checkAuth(context.request, context);
  if (!auth.ok) {
    return new Response(JSON.stringify({ success: false, error: auth.error }), { status: auth.status, headers });
  }

  const kvInfo = getKV(context);
  const subtle = await testSubtle();
  const random = testGetRandomValues();
  const kvTtl = await testKvTtl(kvInfo);

  // Set-Cookie 探测：我们在响应头里尝试下发一个 probe cookie，看是否被剥离（由调用方检查响应头）
  headers['Set-Cookie'] = 'probe=1; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=60';

  const jwtSecret = getJwtSecret(context);
  const envSeen = {
    AUTH_ADMIN_TOKEN: !!getAdminToken(context),
    AUTH_JWT_SECRET: !!jwtSecret,
    KV: kvInfo ? kvInfo.name : null,
  };

  const allPass = subtle.pass && random.pass && kvTtl.pass && envSeen.AUTH_JWT_SECRET && envSeen.AUTH_ADMIN_TOKEN;

  return new Response(JSON.stringify({
    success: true,
    allPass,
    probe: {
      subtle,
      getRandomValues: random,
      kvTtl,
      setCookie: { pass: true, detail: '已尝试 Set-Cookie: probe=1，请检查响应头是否被保留' },
      env: envSeen,
    },
    note: allPass ? '四项均绿，可进入 Step2' : '有红项，请按 v3 退化方案调整',
  }), { status: 200, headers });
}

export function onRequestOptions(context) {
  const origin = context.request.headers.get('origin') || '';
  const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    },
  });
}
