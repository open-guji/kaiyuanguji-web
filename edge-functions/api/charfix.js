// 阅读页「改字」与专名意见端点（GUJI-561，规格 ai-team 仓 team/网站/GUJI-561-charfix-接口规格.md）
//
//   POST  公开 —— 读者对对读章的某一格提出改字（kind=char，缺省），或对某个专名提意见（kind=entity），
//         或拖选一段字报问题（kind=span：错字、缺字、多字、次序、标点、分段、标题、小注、专名、其他；GUJI-597 反馈设计）。
//         同来源对同一格（同一专名）再提会覆盖前一条。
//   GET   **只开管理读**（管理 token 或成员 cookie），按前缀导出；公开读一律 401。
//
// 沿用 cellreview.js / feedback.js：CORS、FEEDBACK_KV、管理员 token／成员 cookie、按 IP 限速、voter 规则。
// 网站不改正文：记录由下游落成 GUJI-541 对照表的 A 类行（`change=A｜cell_id｜old_char｜new_char`），合入走 PR。
// 服务端拿不到 char.json，所以不判 old_char 是否与该格原字一致（下游导入时核）。
//
// key：
//   改字  `cf:<book>:<volume>:<text_version>:<cell_id>:<voter>`
//   专名  `ce:<book>:<volume>:<entity_id>:<voter>`（必填 entity_id／volume／chapter／anchor.start／anchor.end，GUJI-592）
//   一段  `cs:<book>:<volume>:<text_version>:<start>-<end>:<sub>:<voter>`（start／end 是选区首末字的格位，同一格时相等）
//   书在最前，导出按 `cf:<book>:`（可再接 volume、text_version）前缀列，不全库 list。
// voter＝sha256(aid|ip) 前 16 位，与精校同一规则；值只存 voter，不存 aid、不存 IP。

import {
  getCorsHeaders, ALLOWED_ORIGINS, checkAdminAuth, checkMemberCookie, bearerToken, getKV, getClientIp, sha256Hex,
} from './feedback.js';
import { isSingleChar, checkRateLimit } from './cellreview.js';

const BASIS_MAX = 500;
const NOTE_MAX = 500;
const TEXT_MAX = 200; // 专名原文
const TTL_SECONDS = 180 * 24 * 60 * 60; // 180 天：处理侧每日导入，留足余量
// EdgeOne Pages KV 平台口径（GUJI-590 核对 https://pages.edgeone.ai/document/kv-storage ）：list 每页最多 256（＝LIST_MAX），
// 带返回的 cursor 翻到 complete 为止；最终一致，边缘节点缓存最长 60 秒（同来源覆盖、限速计数跨节点可能晚到，够用）；
// key ≤512 B、value ≤25 MB、每账户 1 GB。文档写 key「仅支持数字、字母及下划线」，而本端点与 cellreview／feedback 的 key 都带 `:`／`.`，
// 文档也没提 expirationTtl——两点以 staging 实测为准，见 GUJI-590。
const LIST_MAX = 256;
const GET_BATCH = 20;
const ENTITY_IDS_MAX = 8;
const SPAN_TEXT_MAX = 64; // 选中的原文、建议的改法
/** kind=span 的问题类别：错字 缺字 多字 次序 标点 分段 标题 小注（双行夹注） 专名 其他 */
export const SPAN_SUBS = ['wrong', 'missing', 'extra', 'order', 'punct', 'para', 'heading', 'note', 'entity', 'other'];

const RE_BOOK = /^[0-9a-z]{4,24}$/;
const RE_VOL = /^[A-Za-z0-9._-]{1,16}$/;
const RE_VERSION = /^[A-Za-z0-9._-]{1,16}$/;
const RE_CELL = /^\d{1,6}:\d{1,4}:-?\d{1,4}[ab]?$/; // 与 cellreview／lib/proof.ts 同一坐标；另收抬头字的 -1 格（框外上方）
const RE_AID = /^[A-Za-z0-9_-]{8,64}$/;
const RE_ENTITY = /^e\d{1,8}$/; // 册内唯一的实体 id，如 e01384
const RE_BID = /^[0-9a-z]{4,24}$/; // book-index 里的条目 id（hixhd… 形）
// 组字式 {{…}}：花括号里一段不含空白／控制符／花括号的描述（IDS 串或「虫+斤」之类）
const RE_COMPOSED = /^\{\{[^{}\s\p{Cc}\p{Cf}]{1,30}\}\}$/u;
const FIG_BOX = '□';
const ALT_MAX = 60; // 图形说明，与精校票 alt 同上限

// 改字比精校的「点一格」慢得多，限得更紧；前缀独立，不占精校名额
const RATE_OPTS = { max: 30, prefix: 'ratelimit:cf:' };

const json = (headers, status, body) => new Response(JSON.stringify(body), { status, headers });

/** 新字：恰好一个字（含 CJK 扩展区），或 {{组字式}} */
export function isNewChar(v) {
  return typeof v === 'string' && (isSingleChar(v) || RE_COMPOSED.test(v));
}

function optText(v, max, name) {
  if (v === undefined || v === null) return { value: '' };
  if (typeof v !== 'string') return { error: `${name} 须为字符串` };
  if ([...v].length > max) return { error: `${name} 不能超过 ${max} 字` };
  return { value: v.trim() };
}

const missing = (v) => v === undefined || v === null || v === '';

function checkAnchorCell(c) {
  return typeof c === 'string' && RE_CELL.test(c);
}

/** 校验并规整一条记录；失败返回 { error, field? }。kind 缺省 char */
export function validateFix(body) {
  if (!body || typeof body !== 'object') return { error: '请求体须为 JSON 对象' };
  const kind = body.kind === undefined ? 'char' : body.kind;
  if (kind !== 'char' && kind !== 'entity' && kind !== 'span') return { error: 'kind 无效' };
  const { book_id: book, volume } = body;
  if (missing(book)) return { error: '缺 book_id', field: 'book_id' };
  if (typeof book !== 'string' || !RE_BOOK.test(book)) return { error: 'book_id 无效', field: 'book_id' };
  if (missing(volume)) return { error: '缺 volume', field: 'volume' };
  if (typeof volume !== 'string' || !RE_VOL.test(volume)) return { error: 'volume 无效', field: 'volume' };
  if (typeof body.aid !== 'string' || !RE_AID.test(body.aid)) return { error: 'aid 无效' };

  if (kind === 'char') {
    const { text_version: tv, cell_id: cell, old_char: oldChar } = body;
    // 「这是图形，不是字」（GUJI-737 图片格）：figure=true，new_char 一律记 □（图片格的 c 就是 □），alt 可选
    const figure = body.figure === true;
    const newChar = figure ? FIG_BOX : body.new_char;
    if (typeof tv !== 'string' || !RE_VERSION.test(tv)) return { error: 'text_version 无效' };
    if (typeof cell !== 'string' || !RE_CELL.test(cell)) return { error: 'cell_id 无效' };
    if (!isNewChar(newChar)) return { error: 'new_char 须为单个字或 {{组字式}}' };
    const alt = figure ? optText(body.alt, ALT_MAX, 'alt') : { value: '' };
    if (alt.error) return { error: alt.error };
    let old = '';
    if (oldChar !== undefined && oldChar !== null && oldChar !== '') {
      if (typeof oldChar !== 'string' || [...oldChar].length > 32) return { error: 'old_char 无效' };
      old = oldChar;
    }
    if (!figure && old === newChar) return { error: '建议字与原字相同' };
    const basis = optText(body.basis, BASIS_MAX, 'basis');
    if (basis.error) return { error: basis.error };
    let entityIds = [];
    if (body.entity_ids !== undefined && body.entity_ids !== null) {
      const ids = body.entity_ids;
      if (!Array.isArray(ids) || ids.length > ENTITY_IDS_MAX || !ids.every((x) => typeof x === 'string' && RE_ENTITY.test(x))) {
        return { error: 'entity_ids 无效' };
      }
      entityIds = [...new Set(ids)];
    }
    return {
      value: {
        kind, book_id: book, volume, text_version: tv, cell_id: cell, old_char: old, new_char: newChar,
        ...(figure ? { figure: true, ...(alt.value ? { alt: alt.value } : {}) } : {}),
        basis: basis.value, entity_ids: entityIds, aid: body.aid,
      },
    };
  }

  if (kind === 'span') {
    // 拖选一段报问题：首末格位＋类别＋（可选）建议改法＋说明。建议改法与说明至少有一样，不然无从核
    const { text_version: tv, start, end, sub } = body;
    if (typeof tv !== 'string' || !RE_VERSION.test(tv)) return { error: 'text_version 无效', field: 'text_version' };
    if (!checkAnchorCell(start)) return { error: 'start 不是合法格位（如 4:3:8a）', field: 'start' };
    if (!checkAnchorCell(end)) return { error: 'end 不是合法格位（如 4:3:8a）', field: 'end' };
    if (!SPAN_SUBS.includes(sub)) return { error: 'sub 无效', field: 'sub' };
    const oldText = optText(body.old_text, SPAN_TEXT_MAX, 'old_text');
    if (oldText.error) return { error: oldText.error, field: 'old_text' };
    const newText = optText(body.new_text, SPAN_TEXT_MAX, 'new_text');
    if (newText.error) return { error: newText.error, field: 'new_text' };
    const note = optText(body.note, NOTE_MAX, 'note');
    if (note.error) return { error: note.error, field: 'note' };
    if (!newText.value && !note.value) return { error: '建议改法与说明至少填一项', field: 'note' };
    if (newText.value && newText.value === oldText.value) return { error: '建议改法与原文相同', field: 'new_text' };
    return {
      value: {
        kind, book_id: book, volume, text_version: tv, start, end, sub,
        old_text: oldText.value, new_text: newText.value, note: note.value, aid: body.aid,
      },
    };
  }

  // kind=entity：对某个专名的意见。anchor／text／entity_version 供 id 对不上时回找；target 是 book-index 的链接目标，另一栏。
  // GUJI-592：必填 entity_id（册内 id，e01384 形）＋册（volume，上面已核）＋章（chapter：阅读页的章号，即 index.json 章条目的 file；现有数据一章一册，与 volume 同值，但分开存免得将来一册多章时对不上）＋锚点格号（anchor.start／end），
  // 缺哪项、哪项不合法都直说是哪项（并在 field 里给出字段名），前端与下游据此对得上
  const { entity_id: eid, entity_version: ev, chapter, anchor } = body;
  if (missing(eid)) return { error: '缺 entity_id', field: 'entity_id' };
  if (typeof eid !== 'string' || !RE_ENTITY.test(eid)) return { error: 'entity_id 无效（须为册内 id，如 e01384）', field: 'entity_id' };
  if (missing(chapter)) return { error: '缺 chapter', field: 'chapter' };
  if (typeof chapter !== 'string' || !RE_VOL.test(chapter)) return { error: 'chapter 无效', field: 'chapter' };
  if (missing(anchor)) return { error: '缺 anchor', field: 'anchor' };
  if (typeof anchor !== 'object' || Array.isArray(anchor)) return { error: 'anchor 须为 {start, end}', field: 'anchor' };
  for (const k of ['start', 'end']) {
    if (missing(anchor[k])) return { error: `缺 anchor.${k}`, field: `anchor.${k}` };
    if (!checkAnchorCell(anchor[k])) return { error: `anchor.${k} 不是合法格位（如 4:3:8a）`, field: `anchor.${k}` };
  }
  if (missing(ev)) return { error: '缺 entity_version', field: 'entity_version' };
  if (typeof ev !== 'string' || !RE_VERSION.test(ev)) return { error: 'entity_version 无效', field: 'entity_version' };
  if (typeof body.text !== 'string' || !body.text.trim() || [...body.text].length > TEXT_MAX) return { error: 'text 无效' };
  const note = optText(body.note, NOTE_MAX, 'note');
  if (note.error) return { error: note.error };
  if (!note.value) return { error: 'note 必填' };
  let target;
  if (body.target !== undefined && body.target !== null) {
    const tid = body.target && typeof body.target === 'object' ? body.target.entity_id : undefined;
    if (typeof tid !== 'string' || !RE_BID.test(tid)) return { error: 'target.entity_id 无效' };
    target = { entity_id: tid };
  }
  return {
    value: {
      kind, book_id: book, volume, chapter, entity_id: eid, entity_version: ev,
      anchor: { start: anchor.start, end: anchor.end }, text: body.text.trim(), note: note.value,
      ...(target ? { target } : {}), aid: body.aid,
    },
  };
}

export async function onRequestPost(context) {
  const headers = getCorsHeaders(context.request);
  try {
    let body;
    try { body = await context.request.json(); } catch { return json(headers, 400, { success: false, error: '请求体不是合法 JSON' }); }
    const v = validateFix(body);
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
    const key = rest.kind === 'char'
      ? `cf:${rest.book_id}:${rest.volume}:${rest.text_version}:${rest.cell_id}:${voter}`
      : rest.kind === 'span'
        ? `cs:${rest.book_id}:${rest.volume}:${rest.text_version}:${rest.start}-${rest.end}:${rest.sub}:${voter}`
        : `ce:${rest.book_id}:${rest.volume}:${rest.entity_id}:${voter}`;
    await kv.put(key, JSON.stringify({ v: 1, ...rest, voter, ts: Date.now() }), { expirationTtl: TTL_SECONDS });
    return json(headers, 200, { success: true });
  } catch (e) {
    console.error('Charfix POST error:', e);
    return json(headers, 500, { success: false, error: '服务器错误' });
  }
}

const KIND_PREFIX = { char: 'cf', entity: 'ce', span: 'cs' };

/** 管理读：?book=<book>[&kind=char|entity|span][&volume=<册>[&text_version=<版>]][&limit=<=256>][&cursor=] */
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
    const kind = url.searchParams.get('kind') || 'char';
    if (!Object.prototype.hasOwnProperty.call(KIND_PREFIX, kind)) return json(headers, 400, { success: false, error: 'kind 无效' });
    const volume = url.searchParams.get('volume') || '';
    if (volume && !RE_VOL.test(volume)) return json(headers, 400, { success: false, error: 'volume 无效' });
    const tv = url.searchParams.get('text_version') || '';
    if (tv && (kind === 'entity' || !volume || !RE_VERSION.test(tv))) return json(headers, 400, { success: false, error: 'text_version 只能与 volume 一起用于 kind=char／span' });
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '200', 10) || 200, 1), LIST_MAX);
    const cursor = url.searchParams.get('cursor') || '';
    const kv = getKV(context);
    if (!kv) return json(headers, 500, { success: false, error: '服务配置错误：KV 未绑定' });

    const prefix = `${KIND_PREFIX[kind]}:${book}:${volume ? `${volume}:` : ''}${tv ? `${tv}:` : ''}`;
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
    console.error('Charfix GET error:', e);
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
