// POST /api/auth/nickname — 登录会员设置（或清除）自己的昵称。身份只认已验签的 session cookie。
import { checkMemberCookie, d1Kv } from '../feedback.js';
import { SITE_ORIGINS } from '../hosts.js';
const ALLOWED_ORIGINS = [...SITE_ORIGINS, 'https://open-guji.github.io', 'http://localhost:3000', 'http://localhost:5173'];
const NICK_MAX = 20;
function getCorsHeaders(request) { const origin = request.headers.get('origin') || ''; const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]; return { 'Access-Control-Allow-Origin': corsOrigin, 'Content-Type': 'application/json' }; }
const json = (headers, status, body) => new Response(JSON.stringify(body), { status, headers });

/** 返回 { nickname }（'' 表示清除）或 { error }。昵称公开显示：不许像邮箱、网址，不许控制字符。 */
export function validateNickname(raw) {
  if (typeof raw !== 'string') return { error: '昵称格式不对' };
  const v = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!v) return { nickname: '' };
  if ([...v].length > NICK_MAX) return { error: `昵称最多 ${NICK_MAX} 个字` };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/.test(v)) return { error: '昵称含有不能用的字符' };
  if (/[@<>]|https?:|www\.|\.(com|cn|net|org)\b/i.test(v)) return { error: '昵称不能像邮箱或网址' };
  return { nickname: v };
}

export async function onRequestPost(context) {
  const headers = getCorsHeaders(context.request);
  try {
    const origin = context.request.headers.get('origin');
    if (origin && !ALLOWED_ORIGINS.includes(origin)) return json(headers, 403, { success: false, error: '来源不允许' });
    const member = await checkMemberCookie(context.request, context, null);
    if (!member) return json(headers, 401, { success: false, error: '未登录' });
    let body;
    try { body = await context.request.json(); } catch { return json(headers, 400, { success: false, error: '请求格式不对' }); }
    const v = validateNickname(body && body.nickname);
    if (v.error) return json(headers, 400, { success: false, error: v.error });
    const kv = d1Kv(context, 'AUTH_KV');
    if (!kv) return json(headers, 503, { success: false, error: 'KV 未绑定' });
    const cur = await kv.get(`member:${member.email}`, 'json');
    if (!cur || typeof cur !== 'object' || cur._deleted) return json(headers, 401, { success: false, error: '成员不存在或已移除' });
    const next = { ...cur };
    if (v.nickname) next.nickname = v.nickname; else delete next.nickname;
    await kv.put(`member:${member.email}`, JSON.stringify(next));
    return json(headers, 200, { success: true, nickname: v.nickname });
  } catch (e) {
    console.error('nickname error', e);
    return json(headers, 500, { success: false, error: '保存失败' });
  }
}
export function onRequestOptions(context) {
  const origin = context.request.headers.get('origin') || '';
  const corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': corsOrigin, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' } });
}
