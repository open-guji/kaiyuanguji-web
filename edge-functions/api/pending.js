// 待审单（条目）直读端点（A31 11-10，设计 guji-manager doc/00-总览/设计-待审单进KV.md）
//
//   GET  公开 —— ?book=<书>&vol=<章> 返回该章当前待审单（guji-proof 同格式的 JSON，与 COS 的 proof/<书>/<章>.pending.json 一致），
//        边缘短缓存 15 秒。没有给 404，页面退回读 COS。
//   POST 管理（FEEDBACK_ADMIN_TOKEN）—— 改单，不走 COS 发布、不等 CDN：
//        {op:'put',   book, vol, doc}              整张单替换（doc.rev 必填，cells 数组）
//        {op:'hide',  book, vol, items:[条目 id…], cells:[格号…], why?, by?}   撤下：这些格从单上拿掉，记进 withdrawn[]（与 guji-manager export 同一键，可 unhide 放回）
//        {op:'unhide',book, vol, items:[…]}        放回 withdrawn[] 里的格
//        {op:'delete',book, vol}                   删掉 KV 里这章（页面退回 COS）
//        可带 expect_rev：当前单的 rev 对不上就 409（防止把别的轮的单当成现行单改）
//
// key：`pd:<book>:<vol>`，值是整张单 JSON（几十 KB，EdgeOne KV 单值上限 25 MB），不设过期。
// 图仍在 COS（文件名带内容哈希、不可变）：put 之前，调用方要保证单里 sprites[] 的图已在 COS（manager 会 HEAD 核对，缺图就走 proofing-sync）。

import { getCorsHeaders, ALLOWED_ORIGINS, checkAdminAuth, bearerToken, getKV } from './feedback.js';

const RE_BOOK = /^[0-9a-z]{4,24}$/;
const RE_VOL = /^[A-Za-z0-9._-]{1,16}$/;
const RE_REV = /^[A-Za-z0-9._-]{1,64}$/;
const RE_ITEM = /^pi_[0-9a-f]{12}$/;
const RE_CELL = /^\d{1,6}:\d{1,4}:\d{1,4}[ab]?$/;
const MAX_BYTES = 4 * 1024 * 1024;

const json = (headers, status, body) => new Response(JSON.stringify(body), { status, headers });
export const pdKey = (book, vol) => `pd:${book}:${vol}`;

/** 一格的条目 id（单上每格的 id，格号键是 cell，旧单叫 a） */
const itemOf = (c) => (c && typeof c.id === 'string' ? c.id : '');
const cellOf = (c) => (c && (c.cell || c.a)) || '';

function validDoc(doc) {
  return !!doc && typeof doc === 'object' && !Array.isArray(doc) && typeof doc.rev === 'string' && RE_REV.test(doc.rev) && Array.isArray(doc.cells);
}

export async function onRequestGet(context) {
  const headers = { ...getCorsHeaders(context.request), 'Content-Type': 'application/json; charset=utf-8' };
  try {
    const url = new URL(context.request.url);
    const book = url.searchParams.get('book') || '';
    const vol = url.searchParams.get('vol') || '';
    if (!RE_BOOK.test(book) || !RE_VOL.test(vol)) return json({ ...headers, 'Cache-Control': 'no-store' }, 400, { success: false, error: 'book／vol 无效' });
    const kv = getKV(context);
    if (!kv) return json({ ...headers, 'Cache-Control': 'no-store' }, 404, { success: false, error: '无' });
    const doc = await kv.get(pdKey(book, vol), 'json');
    if (!doc) return json({ ...headers, 'Cache-Control': 'public, max-age=15' }, 404, { success: false, error: '无' });
    return json({ ...headers, 'Cache-Control': 'public, max-age=15' }, 200, doc);
  } catch (e) {
    console.error('Pending GET error:', e);
    return json({ ...headers, 'Cache-Control': 'no-store' }, 500, { success: false, error: '服务器错误' });
  }
}

export async function onRequestPost(context) {
  const headers = { ...getCorsHeaders(context.request), 'Cache-Control': 'no-store' };
  try {
    const authed = checkAdminAuth(bearerToken(context.request), context);
    if (!authed.ok) return json(headers, authed.status, { success: false, error: authed.error });
    let body;
    try { body = await context.request.json(); } catch { return json(headers, 400, { success: false, error: '请求体不是合法 JSON' }); }
    const { op, book, vol } = body || {};
    if (!RE_BOOK.test(book || '') || !RE_VOL.test(vol || '')) return json(headers, 400, { success: false, error: 'book／vol 无效' });
    const kv = getKV(context);
    if (!kv) return json(headers, 500, { success: false, error: '服务配置错误：KV 未绑定' });
    const key = pdKey(book, vol);

    if (op === 'put') {
      if (!validDoc(body.doc)) return json(headers, 400, { success: false, error: 'doc 须有 rev 和 cells[]' });
      const text = JSON.stringify(body.doc);
      if (text.length > MAX_BYTES) return json(headers, 413, { success: false, error: '单子过大' });
      await kv.put(key, text);
      return json(headers, 200, { success: true, rev: body.doc.rev, cells: body.doc.cells.length });
    }
    if (op === 'delete') {
      await kv.delete(key);
      return json(headers, 200, { success: true });
    }
    if (op === 'hide' || op === 'unhide') {
      const items = Array.isArray(body.items) ? body.items : [];
      const cells = Array.isArray(body.cells) ? body.cells : [];
      if (!items.length && !cells.length) return json(headers, 400, { success: false, error: 'items／cells 至少给一个' });
      if (items.some((x) => !RE_ITEM.test(x)) || cells.some((x) => !RE_CELL.test(x))) return json(headers, 400, { success: false, error: '条目 id 或格号格式不对' });
      const doc = await kv.get(key, 'json');
      if (!doc || !validDoc(doc)) return json(headers, 404, { success: false, error: 'KV 里没有这一章的单子，先 put' });
      if (body.expect_rev && body.expect_rev !== doc.rev) return json(headers, 409, { success: false, error: `现行单 rev 是 ${doc.rev}，不是 ${body.expect_rev}` });
      const hit = (c) => items.includes(itemOf(c)) || cells.includes(cellOf(c));
      const gone0 = Array.isArray(doc.withdrawn) ? doc.withdrawn : [];
      let changed = 0;
      if (op === 'hide') {
        const mark = { withdrawn: { by: String(body.by || '').slice(0, 40), at: new Date().toISOString(), why: String(body.why || '').slice(0, 200) } };
        const gone = doc.cells.filter(hit).map((c) => ({ ...c, ...mark }));
        changed = gone.length;
        doc.cells = doc.cells.filter((c) => !hit(c));
        doc.withdrawn = [...gone0, ...gone];
      } else {
        const back = gone0.filter(hit).map(({ withdrawn, ...c }) => c); // eslint-disable-line no-unused-vars
        changed = back.length;
        doc.withdrawn = gone0.filter((c) => !hit(c));
        doc.cells = [...doc.cells, ...back];
      }
      if (!doc.withdrawn.length) delete doc.withdrawn;
      await kv.put(key, JSON.stringify(doc));
      return json(headers, 200, { success: true, rev: doc.rev, changed, cells: doc.cells.length });
    }
    return json(headers, 400, { success: false, error: 'op 须为 put／hide／unhide／delete' });
  } catch (e) {
    console.error('Pending POST error:', e);
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
