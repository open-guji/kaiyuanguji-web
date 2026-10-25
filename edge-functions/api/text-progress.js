// 后台「文本整理」栏目的数据（A41，2026-10-25；设计 docs/text-progress.md）
//
//   GET  只给管理员：admin 成员 cookie，或 Authorization: Bearer <FEEDBACK_ADMIN_TOKEN>
//        → { success, snapshot | null, stored_at?, bytes? }
//   POST 只认 FEEDBACK_ADMIN_TOKEN（定时任务 text-progress.yml 用）：请求体是整份快照，原样存进 KV，覆盖上一份
//        → { success, bytes, stored_at }
//
// 数据的真源是 Neon 中心库的 progress schema（各领域 job 写）。网站在国内 EdgeOne 上，不直连 Neon，
// 由定时任务（ops/text-progress/sync.py export --put）把表导出成快照传到这里；后台页 /admin/text 只读这份快照。
// 「重跑任务」栏（section=jobs）例外：配了环境变量 PROGRESS_READ_DATABASE_URL（Neon 只读连接串）时，GET 先实时读
// progress.metric 里这一栏，读到就覆盖快照里的同栏；超时或失败就用快照，快照里的 live 字段标明这次是实时还是退回。
// 快照存 FEEDBACK_KV 的一个键（`tp:snapshot`，前缀 tp: 与 fb_／cr:／ce: 互不干扰），不新建 KV。

import { getCorsHeaders, ALLOWED_ORIGINS, checkAdminAuth, checkMemberCookie, bearerToken, getKV } from './feedback.js';

export const SNAPSHOT_KEY = 'tp:snapshot';
export const SNAPSHOT_SCHEMA = 'text-progress/1';
export const MAX_BYTES = 5 * 1024 * 1024; // 几十册时约几十 KB，留足余量；KV 单值上限 25 MB

export const LIVE_SECTIONS = ['jobs'];
const LIVE_TIMEOUT_MS = 4000;

function getLiveUrl(context) {
  if (context && context.env && context.env.PROGRESS_READ_DATABASE_URL) return context.env.PROGRESS_READ_DATABASE_URL;
  return (typeof PROGRESS_READ_DATABASE_URL !== 'undefined') ? PROGRESS_READ_DATABASE_URL : null;
}

/**
 * 经 Neon 的 SQL-over-HTTP（`https://<host>/sql`，连接串放在 Neon-Connection-String 头）读实时栏目。
 * 返回 { metrics, sections }；没配、超时、报错都返回 { error }（不抛），调用方退回快照。
 */
export async function readLive(connUrl, fetchImpl = fetch, timeoutMs = LIVE_TIMEOUT_MS) {
  if (!connUrl) return { error: 'not-configured' };
  let host;
  try { host = new URL(connUrl).host; } catch { return { error: 'bad-url' }; }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const q = (query, params) => fetchImpl(`https://${host}/sql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Neon-Connection-String': connUrl },
    body: JSON.stringify({ query, params }),
    signal: ctl.signal,
  }).then(async (r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()).rows || [];
  });
  try {
    const metrics = await q(
      'SELECT book_id, vol, section, key, label, value, value_text, unit, detail, sort, writer, at FROM progress.metric WHERE section = ANY($1::text[])',
      [LIVE_SECTIONS]);
    const sections = await q(
      'SELECT section, title, owner, description, sort FROM progress.section WHERE section = ANY($1::text[])',
      [LIVE_SECTIONS]);
    return { metrics, sections };
  } catch (e) {
    return { error: e && e.name === 'AbortError' ? 'timeout' : String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

/** 把实时读到的栏目盖到快照上（同栏整栏替换）；返回新快照，不改原对象 */
export function overlayLive(snapshot, live) {
  const base = snapshot && typeof snapshot === 'object' ? snapshot : { schema: SNAPSHOT_SCHEMA, volumes: [], sections: [], metrics: [] };
  if (!live || live.error) return { ...base, live: { ok: false, error: live ? live.error : 'none' } };
  const iso = (t) => (t ? new Date(t).toISOString() : null);
  const mine = new Set(LIVE_SECTIONS);
  const metrics = [
    ...(base.metrics || []).filter((m) => !mine.has(m.section)),
    ...live.metrics.map((m) => ({ ...m, at: iso(m.at) })),
  ];
  const have = new Set(live.sections.map((x) => x.section));
  const sections = [...(base.sections || []).filter((x) => !have.has(x.section)), ...live.sections]
    .sort((a, b) => (a.sort - b.sort) || String(a.section).localeCompare(String(b.section)));
  return { ...base, sections, metrics, live: { ok: true, at: new Date().toISOString() } };
}

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
    const liveUrl = getLiveUrl(context);
    const [raw, live] = await Promise.all([kv.get(SNAPSHOT_KEY), liveUrl ? readLive(liveUrl) : null]);
    let rec = null;
    if (raw) {
      try { rec = JSON.parse(raw); } catch { if (!liveUrl) return json(headers, 500, { success: false, error: 'KV 里的快照坏了' }); }
    }
    if (!rec && !(live && !live.error)) return json(headers, 200, { success: true, snapshot: null });
    const snapshot = liveUrl ? overlayLive(rec ? rec.snapshot : null, live) : (rec.snapshot ?? null);
    return json(headers, 200, { success: true, snapshot, stored_at: rec && rec.stored_at, bytes: rec && rec.bytes });
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
