// 读者意见的讨论（GUJI-597 反馈设计第四节；用户 10-19 定：不登录，「同意／有不同看法」匿名，回复只要留个称呼）
//
//   POST  公开 —— 对整册读者意见页上的「一处意见」表态（agree｜disagree，同来源同处覆盖），或回复一条（reply，留称呼）。
//   GET   **只开管理读**（管理 token 或成员 cookie），按书（可再接册）前缀导出，供每日 proofing-sync 并进中心库、发公开清单。
//         公开读一律 401：讨论内容随整册意见清单每日发到 COS，网站不直接读 KV。
//
// 「一处意见」用 target 指：`<kind>~<首格>~<末格>~<类别>`（kind＝char｜span｜entity；末格、类别可空），
// 与公开清单 proof/fixes/<书>.json 的并组口径一致（见 nextjs/src/lib/fixes.ts groupFixes）。
//
// key：
//   表态  `tv:<book>:<volume>:<target>:<voter>`（同来源对同一处再表态是覆盖）
//   回复  `tm:<book>:<volume>:<target>:<ts36>-<voter>`（追加；按 IP 限速）
// voter＝sha256(aid|ip) 前 16 位，与改字、精校同一规则；值只存 voter，不存 aid、不存 IP。

import {
  getCorsHeaders, ALLOWED_ORIGINS, checkAdminAuth, checkMemberCookie, bearerToken, getKV, getClientIp, sha256Hex,
} from './feedback.js';
import { checkRateLimit } from './cellreview.js';

const TEXT_MAX = 500;
const NAME_MAX = 20;
const TTL_SECONDS = 180 * 24 * 60 * 60; // 与改字意见同：处理侧每日导入，留足余量
const LIST_MAX = 256;
const GET_BATCH = 20;

const RE_BOOK = /^[0-9a-z]{4,24}$/;
const RE_VOL = /^[A-Za-z0-9._-]{1,16}$/;
const RE_AID = /^[A-Za-z0-9_-]{8,64}$/;
const CELL = String.raw`\d{1,6}:\d{1,4}:-?\d{1,4}[ab]?`;
const SUBS = 'wrong|missing|extra|order|punct|para|heading|note|entity|other';
const RE_TARGET = new RegExp(String.raw`^(char|span|entity)~${CELL}~(${CELL})?~(${SUBS})?$`);
export const STANCES = ['agree', 'disagree', 'reply'];

const RATE_OPTS = { max: 30, prefix: 'ratelimit:th:' };

const json = (headers, status, body) => new Response(JSON.stringify(body), { status, headers });

/** 称呼：去首尾空白，不能含控制符、换行 */
function cleanName(v) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  if (!s || [...s].length > NAME_MAX || /[\p{Cc}\p{Cf}]/u.test(s)) return '';
  return s;
}

/** 校验并规整一条；失败返回 { error, field? } */
export function validateThread(body) {
  if (!body || typeof body !== 'object') return { error: '请求体须为 JSON 对象' };
  const { book_id: book, volume, target, stance } = body;
  if (typeof book !== 'string' || !RE_BOOK.test(book)) return { error: 'book_id 无效', field: 'book_id' };
  if (typeof volume !== 'string' || !RE_VOL.test(volume)) return { error: 'volume 无效', field: 'volume' };
  if (typeof target !== 'string' || !RE_TARGET.test(target)) return { error: 'target 无效', field: 'target' };
  if (!STANCES.includes(stance)) return { error: 'stance 无效', field: 'stance' };
  if (typeof body.aid !== 'string' || !RE_AID.test(body.aid)) return { error: 'aid 无效' };
  if (stance !== 'reply') return { value: { book_id: book, volume, target, stance, aid: body.aid } };
  const name = cleanName(body.name);
  if (!name) return { error: `称呼必填，不超过 ${NAME_MAX} 字`, field: 'name' };
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return { error: '回复内容必填', field: 'text' };
  if ([...text].length > TEXT_MAX) return { error: `回复不能超过 ${TEXT_MAX} 字`, field: 'text' };
  return { value: { book_id: book, volume, target, stance, name, text, aid: body.aid } };
}

export async function onRequestPost(context) {
  const headers = getCorsHeaders(context.request);
  try {
    let body;
    try { body = await context.request.json(); } catch { return json(headers, 400, { success: false, error: '请求体不是合法 JSON' }); }
    const v = validateThread(body);
    if (v.error) return json(headers, 400, { success: false, error: v.error, ...(v.field ? { field: v.field } : {}) });
    const kv = getKV(context);
    if (!kv) return json(headers, 500, { success: false, error: '服务配置错误：KV 未绑定' });
    const limited = await checkRateLimit(kv, context.request, RATE_OPTS);
    if (!limited.ok) {
      return new Response(JSON.stringify({ success: false, error: '提交太频繁，请稍后再试' }), {
        status: 429, headers: { ...headers, 'Retry-After': String(limited.retryAfter) },
      });
    }
    const { aid, ...rest } = v.value;
    const ip = getClientIp(context.request) || '';
    const voter = (await sha256Hex(`${aid}|${ip}`)).slice(0, 16);
    const ts = Date.now();
    const base = `${rest.book_id}:${rest.volume}:${rest.target}`;
    const key = rest.stance === 'reply' ? `tm:${base}:${ts.toString(36)}-${voter}` : `tv:${base}:${voter}`;
    await kv.put(key, JSON.stringify({ v: 1, ...rest, voter, ts }), { expirationTtl: TTL_SECONDS });
    return json(headers, 200, { success: true });
  } catch (e) {
    console.error('Thread POST error:', e);
    return json(headers, 500, { success: false, error: '服务器错误' });
  }
}

/** 管理读：?book=<book>&kind=vote|reply[&volume=<册>][&limit=<=256>][&cursor=] */
export async function onRequestGet(context) {
  const headers = { ...getCorsHeaders(context.request), 'Cache-Control': 'no-store' };
  try {
    let authed = checkAdminAuth(bearerToken(context.request), context);
    if (!authed.ok && authed.status === 401) {
      const member = await checkMemberCookie(context.request, context, ['reviewer', 'editor', 'admin']);
      if (member) authed = { ok: true };
    }
    if (!authed.ok) return json(headers, authed.status, { success: false, error: authed.error });
    const url = new URL(context.request.url);
    const book = url.searchParams.get('book') || '';
    if (!RE_BOOK.test(book)) return json(headers, 400, { success: false, error: 'book 必填' });
    const kind = url.searchParams.get('kind') || 'vote';
    if (kind !== 'vote' && kind !== 'reply') return json(headers, 400, { success: false, error: 'kind 无效' });
    const volume = url.searchParams.get('volume') || '';
    if (volume && !RE_VOL.test(volume)) return json(headers, 400, { success: false, error: 'volume 无效' });
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '200', 10) || 200, 1), LIST_MAX);
    const cursor = url.searchParams.get('cursor') || '';
    const kv = getKV(context);
    if (!kv) return json(headers, 500, { success: false, error: '服务配置错误：KV 未绑定' });
    const prefix = `${kind === 'vote' ? 'tv' : 'tm'}:${book}:${volume ? `${volume}:` : ''}`;
    const opts = { prefix, limit };
    if (cursor) opts.cursor = cursor;
    const r = await kv.list(opts);
    const names = (r.keys || []).map((k) => k.key);
    const items = [];
    for (let i = 0; i < names.length; i += GET_BATCH) {
      const vals = await Promise.all(names.slice(i, i + GET_BATCH).map((k) => kv.get(k, 'json').catch(() => null)));
      for (const v of vals) if (v) items.push(v);
    }
    const done = !!r.complete || !r.cursor;
    return json(headers, 200, { success: true, kind, items, cursor: done ? '' : r.cursor, hasMore: !done });
  } catch (e) {
    console.error('Thread GET error:', e);
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
