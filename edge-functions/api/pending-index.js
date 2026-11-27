// 精校页目录与总数的「现算」剩余格数（GM4 11-27）
//
//   GET 公开 —— ?book=<书>  返回 {book, at, counts:{章:还剩几格}}，按中心库事件现算（已落定、已结的格不算），边缘缓存 30 秒。
//   读不到中心库回 503；页面据此沿用 proofing-sync 发站时的静态总表（index.json），不挡读者。
//
// 为什么要有：index.json 是发站时生成的静态总表，格数不随事件变。打开精校页先显示总表里的数（如史記 886），
// 各章待审单载进来后才降到现算的数（236），用户看到数字一路往下掉。现在页面先取本接口，一开始就是现算的数。

import { getCorsHeaders, ALLOWED_ORIGINS, readPendingLiveCounts } from './feedback.js';

const RE_BOOK = /^[0-9a-z]{4,24}$/;
const json = (headers, status, body) => new Response(JSON.stringify(body), { status, headers });

export async function onRequestGet(context) {
  const headers = { ...getCorsHeaders(context.request), 'Content-Type': 'application/json; charset=utf-8' };
  const book = new URL(context.request.url).searchParams.get('book') || '';
  if (!RE_BOOK.test(book)) return json({ ...headers, 'Cache-Control': 'no-store' }, 400, { success: false, error: 'book 无效' });
  const out = await readPendingLiveCounts(context, book);
  if (!out) return json({ ...headers, 'Cache-Control': 'no-store' }, 503, { success: false, error: '现算剩余格数暂时读不到' });
  return json({ ...headers, 'Cache-Control': 'public, max-age=30' }, 200, out);
}

export function onRequestOptions(context) {
  const origin = context.request.headers.get('origin') || '';
  const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return new Response(null, {
    status: 204,
    headers: { 'Access-Control-Allow-Origin': corsOrigin, 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' },
  });
}
