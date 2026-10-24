// 精校页意见端点（GUJI-551，设计 team/整理/设计/文本整理三阶段流程.md §6.2）
//
//   POST  公开 —— 读者对「某册某格」提交一条意见（choice 七档之一）。同格同来源重复提交覆盖旧票。
//   GET   **只开管理读**（管理 token 或成员 cookie）——按 rev 前缀导出全部票，供每日导入脚本用。
//         公开读一律 401，不返回任何内容。
//
// 沿用 feedback.js：CORS、FEEDBACK_KV 绑定、管理员 token／成员 cookie、按 IP 限速（sha256，不存明文 IP）。
// 不新建 KV：key 前缀 `cr:`（feedback.js 只扫 `fb_`，互不干扰）。
//
// key：`cr:<rev>:<book>:<a>:<voter>`
//   - rev 在最前，导出时按 `cr:<rev>:` 前缀列，**不全库 list**（EdgeOne KV list 一轮 1.5～3.5 秒）；
//   - 比任务书的 `cr:<rev>:<a>:<voter>` 多了 book：rev（如 vol01-r1）只在一本书内唯一，
//     不同书的同名 rev、同坐标 a 会互相覆盖；
//   - voter＝sha256(aid + ip) 取前 16 位十六进制：aid 是客户端 localStorage 随机 id，ip 是 EdgeOne 给的客户端 IP。
// 值只存 voter，不存 aid、不存 IP。
//
// choice 六档：char（选字／其他字，char 必填且恰好一个字）｜none｜unsure｜cut｜jiazhu｜main，后五档 char 可选。
// 后五档也能带一个字（用户 2026-10-21）：切分错了／小注切错了也先把字给上，格子先过、切分另修；
// 无字、看不清带字下游挂起交人看。只有 char 与 none 会被下游自动落裁决，其余进异常清单。不给公众 damaged。
// figure（GUJI-737／742，10-24）：这一格是图形，不是字（Unicode 没有、也不是汉字）。不许带字；note 是图形说明（阅读器悬停、
// 复制〔图：说明〕用它，可空）。下游 cv `guji cellvotes` 映射成人裁 confirm v=figure，见 cv doc/design/图片格与插图-处理流程.md。

import {
  getCorsHeaders, ALLOWED_ORIGINS, checkAdminAuth, checkMemberCookie, bearerToken, getKV, getClientIp, sha256Hex,
} from './feedback.js';

export const CHOICES = ['char', 'none', 'unsure', 'cut', 'jiazhu', 'main', 'figure'];
// 选的字从哪儿点来（只用来量相似字有没有用，下游不据此落裁决）：候选、相似字、机器读字、自己写、确认预勾、特殊符号
export const PICK_SRCS = ['cand', 'alt', 'machine', 'custom', 'preselect', 'symbol'];
const PICK_RANK_MAX = 99;
const NOTE_MAX = 500;
const SHOWN_MAX = 8;
const TTL_SECONDS = 60 * 24 * 60 * 60; // 60 天
const LIST_MAX = 256; // 与 feedback.js 的 kv.list 同一页大小
const GET_BATCH = 20; // 取值分批，免得一次并发过多子请求

const RE_BOOK = /^[0-9a-z]{4,24}$/;
const RE_VOL = /^[A-Za-z0-9._-]{1,16}$/;
// 章号一律存三位（`001`）：`vol01`、`1` 同一章，下游（cv `opinions.ingest.vol3`、人裁事件规范 §9 O-4）按三位认
const RE_VOL_NUM = /^(?:vol)?0*(\d{1,3})$/i;

/** `vol01`／`1`／`001` → `001`；不是纯章号的（别的书的章名）原样 */
export function normalizeVol(vol) {
  const m = RE_VOL_NUM.exec(vol);
  return m ? m[1].padStart(3, '0') : vol;
}
const RE_REV = /^[A-Za-z0-9._-]{1,64}$/;
const RE_CELL = /^\d{1,6}:\d{1,4}:\d{1,4}[ab]?$/; // 与 lib/proof.ts 的 CELL_KEY 同一坐标
const RE_AID = /^[A-Za-z0-9_-]{8,64}$/;

// 一个人校一页要点几十格，比反馈的 10 条／10 分钟宽得多；仍是按 IP 的固定窗口
const RATE_LIMIT_MAX = 120;
const RATE_LIMIT_WINDOW_SECONDS = 10 * 60;
const RATE_LIMIT_PREFIX = 'ratelimit:cr:';

const json = (headers, status, body) => new Response(JSON.stringify(body), { status, headers });

/** 恰好一个字（按码点；Ext B 等 BMP 外的字算一个）。组合序列不放行 */
export function isSingleChar(v) {
  // 排除控制符（Cc）、格式符（Cf，含零宽）、各类空白分隔符（Z）；不限定汉字——古籍里有私用区造字
  return typeof v === 'string' && [...v].length === 1 && !/[\p{Cc}\p{Cf}\p{Z}]/u.test(v);
}

/** 校验并规整一条意见；失败返回 { error } */
export function validateReview(body) {
  if (!body || typeof body !== 'object') return { error: '请求体须为 JSON 对象' };
  const { book, vol, a, rev, choice } = body;
  if (typeof book !== 'string' || !RE_BOOK.test(book)) return { error: 'book 无效' };
  if (typeof vol !== 'string' || !RE_VOL.test(vol)) return { error: 'vol 无效' };
  if (typeof a !== 'string' || !RE_CELL.test(a)) return { error: 'a（格位坐标）无效' };
  if (typeof rev !== 'string' || !RE_REV.test(rev)) return { error: 'rev 必填且须为合法版本号' };
  if (typeof choice !== 'string' || !CHOICES.includes(choice)) return { error: 'choice 无效' };
  if (typeof body.aid !== 'string' || !RE_AID.test(body.aid)) return { error: 'aid 无效' };

  let char;
  if (choice === 'char') {
    if (!isSingleChar(body.char)) return { error: 'choice=char 时 char 必填且恰好一个字' };
    char = body.char;
  } else if (choice === 'figure') {
    if (body.char !== undefined && body.char !== null && body.char !== '') return { error: 'choice=figure（是图形）时不带字' };
  } else if (body.char !== undefined && body.char !== null && body.char !== '') {
    if (!isSingleChar(body.char)) return { error: 'char 须恰好一个字' };
    char = body.char;
  }

  let note = '';
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== 'string') return { error: 'note 须为字符串' };
    if ([...body.note].length > NOTE_MAX) return { error: `note 不能超过 ${NOTE_MAX} 字` };
    note = body.note.trim();
  }
  let shown = '';
  if (body.shown !== undefined && body.shown !== null) {
    if (typeof body.shown !== 'string' || [...body.shown].length > SHOWN_MAX) return { error: 'shown 无效' };
    shown = body.shown;
  }
  // pick_src／pick_rank／pivot 都可选；只跟着字（char）走，没带字的档带了就忽略（旧页面不带，照常收）
  const pick = {};
  if (char && body.pick_src !== undefined && body.pick_src !== null) {
    if (!PICK_SRCS.includes(body.pick_src)) return { error: 'pick_src 无效' };
    pick.pick_src = body.pick_src;
    if (body.pick_rank !== undefined && body.pick_rank !== null) {
      if (!Number.isInteger(body.pick_rank) || body.pick_rank < 1 || body.pick_rank > PICK_RANK_MAX) return { error: 'pick_rank 无效' };
      pick.pick_rank = body.pick_rank;
    }
    if (body.pivot !== undefined && body.pivot !== null && body.pivot !== '') {
      if (!isSingleChar(body.pivot)) return { error: 'pivot 须恰好一个字' };
      pick.pivot = body.pivot;
    }
  }
  return { value: { book, vol: normalizeVol(vol), a, rev, choice, ...(char ? { char } : {}), note, shown, ...pick, aid: body.aid } };
}

/** 按 IP 的固定窗口限速；max／prefix 缺省是精校的口径，charfix 传自己的（互不占名额） */
export async function checkRateLimit(kv, request, { max = RATE_LIMIT_MAX, prefix = RATE_LIMIT_PREFIX } = {}) {
  if (!kv) return { ok: true };
  const ip = getClientIp(request);
  if (!ip) return { ok: true }; // 取不到 IP 不限速（同 feedback.js：不把取不到 IP 的人挤进同一个名额）
  const nowS = Math.floor(Date.now() / 1000);
  try {
    const key = prefix + (await sha256Hex(ip));
    const cur = (await kv.get(key, 'json')) || {};
    let start = Number(cur.start) || 0;
    let count = Number(cur.count) || 0;
    if (!start || nowS - start >= RATE_LIMIT_WINDOW_SECONDS) { start = nowS; count = 0; }
    if (count >= max) {
      return { ok: false, retryAfter: Math.max(1, start + RATE_LIMIT_WINDOW_SECONDS - nowS) };
    }
    await kv.put(key, JSON.stringify({ start, count: count + 1 }), { expirationTtl: RATE_LIMIT_WINDOW_SECONDS * 2 });
    return { ok: true };
  } catch (e) {
    console.error('精校限速计数失败（放行）:', e);
    return { ok: true };
  }
}

// 精校提交的限速改放函数内存（每个实例各数各的，尽力而为）：提交只剩存票一次 KV 写。
// 原先每票先读再写一个按 IP 的计数键，KV 写慢时（线上 10-23 实测每票多 1–3 秒）同一人连点反复写同一键。
// charfix／thread 仍用上面 KV 版的 checkRateLimit，不动。
const memHits = new Map(); // ipHash → { start, count }
const MEM_HITS_MAX = 5000;
export function memRateLimit(request, { max = RATE_LIMIT_MAX, nowS = Math.floor(Date.now() / 1000) } = {}) {
  const ip = getClientIp(request);
  if (!ip) return { ok: true }; // 同上：取不到 IP 不限速
  let cur = memHits.get(ip);
  if (!cur || nowS - cur.start >= RATE_LIMIT_WINDOW_SECONDS) {
    if (memHits.size >= MEM_HITS_MAX) {
      for (const [k, v] of memHits) if (nowS - v.start >= RATE_LIMIT_WINDOW_SECONDS) memHits.delete(k);
      if (memHits.size >= MEM_HITS_MAX) memHits.clear();
    }
    cur = { start: nowS, count: 0 };
    memHits.set(ip, cur);
  }
  if (cur.count >= max) return { ok: false, retryAfter: Math.max(1, cur.start + RATE_LIMIT_WINDOW_SECONDS - nowS) };
  cur.count += 1;
  return { ok: true };
}
export function resetMemRateLimit() { memHits.clear(); }

function ipKey(context) {
  if (context && context.env && context.env.CELLREVIEW_IP_KEY) return String(context.env.CELLREVIEW_IP_KEY);
  return (typeof CELLREVIEW_IP_KEY !== 'undefined' && CELLREVIEW_IP_KEY) ? String(CELLREVIEW_IP_KEY) : '';
}

async function ipHash(context, ip) {
  const key = ipKey(context);
  if (!key) return '';
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(ip)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

export async function onRequestPost(context) {
  const headers = getCorsHeaders(context.request);
  try {
    let body;
    try { body = await context.request.json(); } catch { return json(headers, 400, { success: false, error: '请求体不是合法 JSON' }); }
    const v = validateReview(body);
    if (v.error) return json(headers, 400, { success: false, error: v.error });
    const kv = getKV(context);
    if (!kv) return json(headers, 500, { success: false, error: '服务配置错误：KV 未绑定' });

    const limited = memRateLimit(context.request);
    if (!limited.ok) {
      return new Response(JSON.stringify({ success: false, error: '提交太频繁，请稍后再试' }), {
        status: 429, headers: { ...headers, 'Retry-After': String(limited.retryAfter) },
      });
    }

    const { aid, ...rest } = v.value;
    const ip = getClientIp(context.request) || '';
    const voter = (await sha256Hex(`${aid}|${ip}`)).slice(0, 16);
    const key = `cr:${rest.rev}:${rest.book}:${rest.a}:${voter}`;
    // iph＝HMAC-SHA256(CELLREVIEW_IP_KEY, ip) 截断：同一 IP 换 aid 也能在统计时识别出来再去重，防刷票；
    // 不存 IP 明文。未加盐的哈希可被穷举还原 IPv4，所以没配密钥就不存 iph。
    const iph = ip ? await ipHash(context, ip) : '';
    const record = { v: 1, ...rest, voter, ...(iph ? { iph } : {}), ts: Date.now() };
    await kv.put(key, JSON.stringify(record), { expirationTtl: TTL_SECONDS });
    return json(headers, 200, { success: true });
  } catch (e) {
    console.error('Cellreview POST error:', e);
    // detail 临时带上原始报错，便于定位线上间歇 500（2026-10-23）；查清后撤掉
    return json(headers, 500, { success: false, error: '服务器错误', detail: String((e && e.message) || e).slice(0, 200) });
  }
}

/** 管理读：?rev=<rev>[&book=<book>][&limit=<=500>][&cursor=<上页返回的 cursor>] */
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
    const rev = url.searchParams.get('rev') || '';
    if (!RE_REV.test(rev)) return json(headers, 400, { success: false, error: 'rev 必填' });
    const book = url.searchParams.get('book') || '';
    if (book && !RE_BOOK.test(book)) return json(headers, 400, { success: false, error: 'book 无效' });
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '200', 10) || 200, 1), LIST_MAX);
    const cursor = url.searchParams.get('cursor') || '';
    const kv = getKV(context);
    if (!kv) return json(headers, 500, { success: false, error: '服务配置错误：KV 未绑定' });

    // 只按 rev（可再加 book）前缀列，一页一页来，调用方带 cursor 翻页
    const prefix = `cr:${rev}:${book ? `${book}:` : ''}`;
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
    return json(headers, 200, { success: true, rev, items, cursor: done ? '' : r.cursor, hasMore: !done });
  } catch (e) {
    console.error('Cellreview GET error:', e);
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
