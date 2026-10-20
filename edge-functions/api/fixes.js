// 整册读者意见的公开读（GUJI-597）：直接读 KV，刚提的意见、刚发的回复马上能看到。
//
//   GET /api/fixes?book=<书>&volume=<册>
//   → { success, book, volumes: {<册>: [条目]}, threads?: {<册>: {<target>: {agree, disagree, replies}}} }
//
// 形状与每日 proofing-sync 发到 COS 的 proof/fixes/<书>.json 一致（nextjs/scripts/lib/fixes-sync.mjs 的 toPublicFix／buildPublicFixes），
// 网站同一套解析、同一个页面；这条是实时的，COS 清单是兜底（本接口取不到时页面退回它）。
// 公开口径与清单相同：voter 只给 6 位、正文脱敏、不带 aid／IP。写入仍走 /api/charfix、/api/thread，本接口只读。
// 站方「隐藏单」（hidden.txt）在中心库，这里读不到，所以直读不应用它；真有要藏的条目，先在 KV 里删。

import { getCorsHeaders, ALLOWED_ORIGINS, checkAdminAuth, checkMemberCookie, bearerToken, getKV, desensitizeText } from './feedback.js';
import { RE_TARGET } from './thread.js';

const RE_BOOK = /^[0-9a-z]{4,24}$/;
const RE_VOL = /^[A-Za-z0-9._-]{1,16}$/;
const LIST_MAX = 256;
const GET_BATCH = 20;
const MAX_KEYS = 1000; // 一册一类的上限：超过就截断，免得一次读太多
export const STATES = ['open', 'adopted', 'rejected', 'discussing'];
const TEAM_NAME = '整理组';
const REASON_MAX = 200;
const RE_VERSION = /^[A-Za-z0-9._-]{1,16}$/;
const CELL_ORDER = /^(\d+):(\d+):(-?\d+)([ab]?)$/;

const json = (headers, status, body) => new Response(JSON.stringify(body), { status, headers });
const clean = (s) => (typeof s === 'string' && s ? desensitizeText(s) : undefined);

function cellOrder(a, b) {
  const pa = String(a).match(CELL_ORDER);
  const pb = String(b).match(CELL_ORDER);
  if (!pa || !pb) return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
  for (let i = 1; i <= 3; i++) if (+pa[i] !== +pb[i]) return +pa[i] - +pb[i];
  return pa[4] < pb[4] ? -1 : pa[4] > pb[4] ? 1 : 0;
}

export function fixAt(r) {
  if (r.kind === 'char') return r.cell_id;
  if (r.kind === 'span') return r.start;
  return r.anchor && r.anchor.start ? r.anchor.start : '';
}

/** 与 fixes-sync.mjs 的 toPublicFix 同形（单测里对过） */
export function toPublicFix(r) {
  const o = { kind: r.kind, at: fixAt(r), who: String(r.voter).slice(0, 6), ts: typeof r.ts === 'number' ? r.ts : undefined };
  if (r.kind === 'char') Object.assign(o, { tv: r.text_version, old: r.old_char || undefined, new: r.new_char, note: clean(r.basis) });
  else if (r.kind === 'span') Object.assign(o, { tv: r.text_version, end: r.end, sub: r.sub, old: r.old_text || undefined, new: r.new_text || undefined, note: clean(r.note) });
  else Object.assign(o, { end: r.anchor && r.anchor.end, ev: r.entity_version, eid: r.entity_id, old: r.text, note: clean(r.note) });
  for (const k of Object.keys(o)) if (o[k] === undefined || o[k] === '') delete o[k];
  return o;
}

/** 一处意见的 target（与 /api/thread、网站 lib/fixes、fixes-sync.mjs 同口径） */
export function targetOf(r) {
  const sub = r.kind === 'span' ? (r.sub || '') : '';
  const end = r.kind === 'char' ? '' : (r.kind === 'span' ? r.end : (r.anchor && r.anchor.end)) || '';
  return `${r.kind}~${fixAt(r)}~${end}~${sub}`;
}

/** KV 记录 → 公开清单形状（单册） */
export function buildLive(book, volume, fixRecs, voteRecs, replyRecs, stateRecs = []) {
  const fixes = fixRecs
    .filter((r) => r && r.book_id === book && r.volume === volume && typeof r.voter === 'string' && fixAt(r))
    .sort((x, y) => cellOrder(fixAt(x), fixAt(y)) || (x.ts || 0) - (y.ts || 0))
    .map(toPublicFix);
  const threads = {};
  const slot = (target) => (threads[target] ||= { agree: 0, disagree: 0, replies: [] });
  for (const r of voteRecs) {
    if (!r || r.book_id !== book || r.volume !== volume || typeof r.target !== 'string') continue;
    if (r.stance === 'agree') slot(r.target).agree++;
    else if (r.stance === 'disagree') slot(r.target).disagree++;
  }
  for (const r of [...replyRecs].filter(Boolean).sort((x, y) => (x.ts || 0) - (y.ts || 0))) {
    if (r.book_id !== book || r.volume !== volume || typeof r.target !== 'string' || r.stance !== 'reply') continue;
    slot(r.target).replies.push({ name: clean(r.name) || '', text: clean(r.text) || '', ts: r.ts, ...(r.team === true ? { team: true } : {}) });
  }
  for (const r of stateRecs) {
    if (!r || r.book_id !== book || r.volume !== volume || typeof r.target !== 'string' || !STATES.includes(r.state) || r.state === 'open') continue;
    slot(r.target).status = { state: r.state, ...(r.version ? { version: r.version } : {}), ...(r.reason ? { reason: clean(r.reason) } : {}), ts: r.ts };
  }
  const out = { book, volumes: { [volume]: fixes } };
  if (Object.keys(threads).length) out.threads = { [volume]: threads };
  return out;
}

async function listAll(kv, prefix) {
  const items = [];
  let cursor = '';
  let seen = 0;
  for (;;) {
    const opts = { prefix, limit: LIST_MAX };
    if (cursor) opts.cursor = cursor;
    const r = await kv.list(opts);
    const names = (r.keys || []).map((k) => k.key);
    seen += names.length;
    for (let i = 0; i < names.length; i += GET_BATCH) {
      const vals = await Promise.all(names.slice(i, i + GET_BATCH).map((k) => kv.get(k, 'json').catch(() => null)));
      for (const v of vals) if (v) items.push(v);
    }
    if (r.complete || !r.cursor || seen >= MAX_KEYS) return items;
    cursor = r.cursor;
  }
}

export async function onRequestGet(context) {
  const headers = { ...getCorsHeaders(context.request), 'Cache-Control': 'no-store' };
  try {
    const url = new URL(context.request.url);
    const book = url.searchParams.get('book') || '';
    const volume = url.searchParams.get('volume') || '';
    if (!RE_BOOK.test(book)) return json(headers, 400, { success: false, error: 'book 无效' });
    if (!RE_VOL.test(volume)) return json(headers, 400, { success: false, error: 'volume 无效' });
    const kv = getKV(context);
    if (!kv) return json(headers, 500, { success: false, error: '服务配置错误：KV 未绑定' });
    const [cf, cs, ce, tv, tm, fs] = await Promise.all([
      listAll(kv, `cf:${book}:${volume}:`),
      listAll(kv, `cs:${book}:${volume}:`),
      listAll(kv, `ce:${book}:${volume}:`),
      listAll(kv, `tv:${book}:${volume}:`),
      listAll(kv, `tm:${book}:${volume}:`),
      listAll(kv, `fs:${book}:${volume}:`),
    ]);
    return json(headers, 200, { success: true, ...buildLive(book, volume, [...cf, ...cs, ...ce], tv, tm, fs) });
  } catch (e) {
    console.error('Fixes GET error:', e);
    return json(headers, 500, { success: false, error: '服务器错误' });
  }
}

/** 整理组回写：校验并规整；失败返回 { error } */
export function validateTeamWrite(body) {
  if (!body || typeof body !== 'object') return { error: '请求体须为 JSON 对象' };
  const { book_id: book, volume, target, state } = body;
  if (typeof book !== 'string' || !RE_BOOK.test(book)) return { error: 'book_id 无效' };
  if (typeof volume !== 'string' || !RE_VOL.test(volume)) return { error: 'volume 无效' };
  if (typeof target !== 'string' || !RE_TARGET.test(target)) return { error: 'target 无效' };
  if (state !== undefined && !STATES.includes(state)) return { error: 'state 无效' };
  const version = body.version === undefined ? '' : body.version;
  if (version !== '' && (typeof version !== 'string' || !RE_VERSION.test(version))) return { error: 'version 无效' };
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if ([...reason].length > REASON_MAX) return { error: `理由不超过 ${REASON_MAX} 字` };
  const reply = typeof body.reply === 'string' ? body.reply.trim() : '';
  if ([...reply].length > 500) return { error: '回复不超过 500 字' };
  if (state === undefined && !reply) return { error: 'state 与 reply 至少要有一项' };
  return { value: { book_id: book, volume, target, state, version, reason, reply } };
}

export async function onRequestPost(context) {
  const headers = { ...getCorsHeaders(context.request), 'Cache-Control': 'no-store' };
  try {
    let authed = checkAdminAuth(bearerToken(context.request), context);
    if (!authed.ok && authed.status === 401) {
      const member = await checkMemberCookie(context.request, context, ['reviewer', 'editor', 'admin']);
      if (member) authed = { ok: true };
    }
    if (!authed.ok) return json(headers, authed.status, { success: false, error: authed.error });
    let body;
    try { body = await context.request.json(); } catch { return json(headers, 400, { success: false, error: '请求体不是合法 JSON' }); }
    const v = validateTeamWrite(body);
    if (v.error) return json(headers, 400, { success: false, error: v.error });
    const kv = getKV(context);
    if (!kv) return json(headers, 500, { success: false, error: '服务配置错误：KV 未绑定' });
    const { book_id, volume, target, state, version, reason, reply } = v.value;
    const ts = Date.now();
    if (state !== undefined) {
      const key = `fs:${book_id}:${volume}:${target}`;
      // open＝撤回状态：写一条 open 记录顶掉旧的（读取时跳过），不依赖 KV 的删除接口
      await kv.put(key, JSON.stringify({ v: 1, book_id, volume, target, state, ...(version ? { version } : {}), ...(reason ? { reason } : {}), ts }));
    }
    if (reply) {
      await kv.put(`tm:${book_id}:${volume}:${target}:${ts.toString(36)}-team`,
        JSON.stringify({ v: 1, book_id, volume, target, stance: 'reply', name: TEAM_NAME, text: reply, team: true, voter: 'team', ts }),
        { expirationTtl: 180 * 24 * 60 * 60 });
    }
    return json(headers, 200, { success: true });
  } catch (e) {
    console.error('Fixes POST error:', e);
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
