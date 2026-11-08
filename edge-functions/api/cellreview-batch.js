// 精校页成批提交端点：跨册聚类审核页（/proofing/<书>/c/<聚类>）一次确认几十格。
//
//   POST { aid, items: [ { book, vol, a, rev, choice, char?, note?, shown?, pick_src?, ... } × ≤ 50 ] }
//     每项和 /api/cellreview 的单格提交同一套校验（validateReview），同样落 `cr:<rev>:<book>:<a>:<voter>`，
//     所以每日 proofing-sync、cellvotes 等下游一概不用改；只是少了一个浏览器连发几十次请求。
//     回 { success, results: [{ a, ok, error? }] }：逐项成败，有的失败不影响别的（同键同值重写幂等，失败的项客户端可重发）。
//     限速：一次批量算 1 次（同 /api/cellreview 的内存计数口径，每 IP 10 分钟 120 次），所以一个人 10 分钟最多成批确认 120×50 格。
//   公开读：不开。读票走 /api/cellreview 的管理读。
import { getCorsHeaders, getKV, getClientIp, sha256Hex } from './feedback.js';
import { validateReview, memRateLimit, ipHash, putTicket } from './cellreview.js';

export const BATCH_MAX = 50;
const PUT_CONCURRENCY = 8; // 一次并发写 KV 的票数，免得子请求太多

const json = (headers, status, body) => new Response(JSON.stringify(body), { status, headers });

export async function onRequestPost(context) {
  const headers = getCorsHeaders(context.request);
  try {
    let body;
    try { body = await context.request.json(); } catch { return json(headers, 400, { success: false, error: '请求体不是合法 JSON' }); }
    if (!body || typeof body !== 'object' || !Array.isArray(body.items)) return json(headers, 400, { success: false, error: 'items 须为数组' });
    if (body.items.length < 1 || body.items.length > BATCH_MAX) return json(headers, 400, { success: false, error: `items 一次 1 到 ${BATCH_MAX} 项` });
    const kv = getKV(context);
    if (!kv) return json(headers, 500, { success: false, error: '服务配置错误：KV 未绑定' });

    const limited = memRateLimit(context.request);
    if (!limited.ok) {
      return new Response(JSON.stringify({ success: false, error: '提交太频繁，请稍后再试' }), {
        status: 429, headers: { ...headers, 'Retry-After': String(limited.retryAfter) },
      });
    }

    const ip = getClientIp(context.request) || '';
    const iph = ip ? await ipHash(context, ip) : '';
    const results = new Array(body.items.length);
    const jobs = [];
    body.items.forEach((item, i) => {
      // aid 在批量层给一次，各项不必重复；项里自带的忽略
      const v = validateReview({ ...(item && typeof item === 'object' ? item : {}), aid: body.aid });
      if (v.error) { results[i] = { a: item && item.a, ok: false, error: v.error }; return; }
      jobs.push({ i, v: v.value });
    });
    for (let s = 0; s < jobs.length; s += PUT_CONCURRENCY) {
      await Promise.all(jobs.slice(s, s + PUT_CONCURRENCY).map(async ({ i, v }) => {
        const { aid, ...rest } = v;
        try {
          const voter = (await sha256Hex(`${aid}|${ip}`)).slice(0, 16);
          const record = { v: 1, ...rest, voter, ...(iph ? { iph } : {}), ts: Date.now() };
          await putTicket(kv, `cr:${rest.rev}:${rest.book}:${rest.a}:${voter}`, JSON.stringify(record), { expirationTtl: 60 * 24 * 60 * 60 });
          results[i] = { a: rest.a, ok: true };
        } catch (e) {
          results[i] = { a: rest.a, ok: false, error: '存票失败，请重试' };
        }
      }));
    }
    const failed = results.filter((r) => !r.ok).length;
    return json(headers, 200, { success: failed === 0, saved: results.length - failed, failed, results });
  } catch (e) {
    console.error('Cellreview batch POST error:', e);
    return json(headers, 500, { success: false, error: '服务器错误' });
  }
}

export { onRequestOptions } from './cellreview.js';
