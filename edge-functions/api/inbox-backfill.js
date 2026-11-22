// 网站票回填 D1（A20 11-21）：开双写之前 KV 里已有的票，按原键、原 ts、value 原样补进 Worker /v1/web/inbox。
//
//   POST（只认管理 token）  { prefix: 'cr:'｜'cf:'｜'cs:'｜'ce:'｜'tv:'｜'tm:'｜'fs:'｜'pd:', cursor?, limit?(≤100，默认 100), dry? }
//   一次请求：KV list 一页（≤limit 个键）→ 逐个读值 → 向 Worker 发 **1 次** POST（EdgeOne 单次函数对外 fetch 约 64 次后 502）。
//   回 { scanned, sent, skipped, cursor, hasMore }；调用方带回 cursor 循环到 hasMore=false。同键覆盖，重跑无害。
//   不补 rev，不改值；tombstone 不在此处理。

import {
  getCorsHeaders, ALLOWED_ORIGINS, checkAdminAuth, bearerToken, getKV, mirrorBatchToInbox,
} from './feedback.js';

const PREFIX_KIND = { 'cr:': 'cellreview', 'cf:': 'charfix', 'cs:': 'charfix', 'ce:': 'charfix', 'tv:': 'thread', 'tm:': 'thread', 'fs:': 'fixstate', 'pd:': 'pending' };
const GET_BATCH = 20;

const json = (headers, status, body) => new Response(JSON.stringify(body), { status, headers });

export async function onRequestPost(context) {
  const headers = { ...getCorsHeaders(context.request), 'Cache-Control': 'no-store' };
  try {
    const authed = checkAdminAuth(bearerToken(context.request), context);
    if (!authed.ok) return json(headers, authed.status, { success: false, error: authed.error });
    let body;
    try { body = await context.request.json(); } catch { return json(headers, 400, { success: false, error: '请求体不是合法 JSON' }); }
    const prefix = body && body.prefix;
    const kind = PREFIX_KIND[prefix];
    if (!kind) return json(headers, 400, { success: false, error: `prefix 须为 ${Object.keys(PREFIX_KIND).join('／')}` });
    const limit = Math.min(Math.max(parseInt(body.limit, 10) || 100, 1), 100);
    const kv = getKV(context);
    if (!kv) return json(headers, 500, { success: false, error: '服务配置错误：KV 未绑定' });

    const opts = { prefix, limit };
    if (body.cursor) opts.cursor = String(body.cursor);
    const r = await kv.list(opts);
    const names = (r.keys || []).map((k) => k.key);
    const items = [];
    let skipped = 0;
    for (let i = 0; i < names.length; i += GET_BATCH) {
      const slice = names.slice(i, i + GET_BATCH);
      const vals = await Promise.all(slice.map((k) => kv.get(k, 'json').catch(() => null)));
      vals.forEach((v, j) => {
        if (v && typeof v === 'object') {
          if (kind === 'pending') { const [, pb, pv] = slice[j].split(':'); items.push({ kind, key: slice[j], value: { book: pb, vol: pv, doc: v } }); }
          else items.push({ kind, key: slice[j], value: v, ...(v.ts ? { ts: v.ts } : {}) });
        }
        else skipped += 1;
      });
    }
    let sent = 0;
    if (items.length && !body.dry) {
      const res = await mirrorBatchToInbox(context, items);
      if (!res.ok) return json(headers, 502, { success: false, error: `写 Worker 失败：${res.error}`, scanned: names.length });
      sent = res.sent;
      skipped += res.skipped;
    }
    const done = !!r.complete || !r.cursor;
    return json(headers, 200, { success: true, scanned: names.length, sent, skipped, cursor: done ? '' : r.cursor, hasMore: !done, ...(body.dry ? { dry: true, would_send: items.length } : {}) });
  } catch (e) {
    console.error('Inbox backfill error:', e);
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
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    },
  });
}
