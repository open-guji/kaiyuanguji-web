// 后台「文本整理」栏目的数据（A41，2026-10-25；设计 docs/text-progress.md）
//
//   GET  只给管理员：admin 成员 cookie，或 Authorization: Bearer <FEEDBACK_ADMIN_TOKEN>
//        → { success, snapshot | null, stored_at?, bytes? }
//   POST 只认 FEEDBACK_ADMIN_TOKEN（定时任务 text-progress.yml 用）：请求体是整份快照，原样存进 KV，覆盖上一份
//        → { success, bytes, stored_at }
//
// 数据的真源是 Neon 中心库的 progress schema（各领域 job 写）。网站在国内 EdgeOne 上，不直连 Neon，
// 由定时任务（ops/text-progress/sync.py export --put）把表导出成快照传到这里；后台页 /admin/text 只读这份快照。
// 快照存 FEEDBACK_KV 的一个键（`tp:snapshot`，前缀 tp: 与 fb_／cr:／ce: 互不干扰），不新建 KV。

import { getCorsHeaders, ALLOWED_ORIGINS, checkAdminAuth, checkMemberCookie, bearerToken, getKV } from './feedback.js';

export const SNAPSHOT_KEY = 'tp:snapshot';
export const SNAPSHOT_SCHEMA = 'text-progress/1';
export const MAX_BYTES = 5 * 1024 * 1024; // 几十册时约几十 KB，留足余量；KV 单值上限 25 MB

const json = (headers, status, body) => new Response(JSON.stringify(body), { status, headers });

/** 快照的最小形状检查：顶层 schema 对、几个数组是数组。字段细节由后台页宽松读，不在这里卡。 */
export function validateSnapshot(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return '快照不是 JSON 对象';
  if (s.schema !== SNAPSHOT_SCHEMA) return `schema 必须是 ${SNAPSHOT_SCHEMA}`;
  for (const k of ['volumes', 'sections', 'metrics']) {
    if (!Array.isArray(s[k])) return `${k} 必须是数组`;
  }
  for (const v of s.volumes) {
    if (!v || typeof v.book_id !== 'string' || typeof v.vol !== 'string' || !v.book_id || !v.vol) {
      return 'volumes 里每一行都要有 book_id、vol';
    }
  }
  return null;
}

export async function onRequestGet(context) {
  const headers = { ...getCorsHeaders(context.request), 'Cache-Control': 'no-store' };
  try {
    let authed = checkAdminAuth(bearerToken(context.request), context);
    if (!authed.ok && authed.status === 401) {
      const member = await checkMemberCookie(context.request, context, ['admin']);
      if (member) authed = { ok: true };
    }
    if (!authed.ok) return json(headers, authed.status, { success: false, error: authed.error });
    const kv = getKV(context);
    if (!kv) return json(headers, 500, { success: false, error: '服务配置错误：KV 未绑定' });
    const raw = await kv.get(SNAPSHOT_KEY);
    if (!raw) return json(headers, 200, { success: true, snapshot: null });
    let rec;
    try { rec = JSON.parse(raw); } catch { return json(headers, 500, { success: false, error: 'KV 里的快照坏了' }); }
    return json(headers, 200, { success: true, snapshot: rec.snapshot ?? null, stored_at: rec.stored_at, bytes: rec.bytes });
  } catch (e) {
    console.error('text-progress GET error:', e);
    return json(headers, 500, { success: false, error: '服务器错误' });
  }
}

export async function onRequestPost(context) {
  const headers = { ...getCorsHeaders(context.request), 'Cache-Control': 'no-store' };
  try {
    // 写只认令牌：成员 cookie 不能改这份数据（数据只从中心库来）
    const authed = checkAdminAuth(bearerToken(context.request), context);
    if (!authed.ok) return json(headers, authed.status, { success: false, error: authed.error });
    const text = await context.request.text();
    const bytes = new TextEncoder().encode(text).length;
    if (bytes > MAX_BYTES) return json(headers, 413, { success: false, error: `快照超过 ${MAX_BYTES} 字节` });
    let snap;
    try { snap = JSON.parse(text); } catch { return json(headers, 400, { success: false, error: '请求体不是合法 JSON' }); }
    const bad = validateSnapshot(snap);
    if (bad) return json(headers, 400, { success: false, error: bad });
    const kv = getKV(context);
    if (!kv) return json(headers, 500, { success: false, error: '服务配置错误：KV 未绑定' });
    const stored_at = new Date().toISOString();
    await kv.put(SNAPSHOT_KEY, JSON.stringify({ stored_at, bytes, snapshot: snap }));
    return json(headers, 200, { success: true, bytes, stored_at });
  } catch (e) {
    console.error('text-progress POST error:', e);
    return json(headers, 500, { success: false, error: '服务器错误' });
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
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    },
  });
}
