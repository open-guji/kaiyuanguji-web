// EdgeOne 边缘函数 → 中心库 Worker（Cloudflare D1）延迟探测（A20，11-20）。只读，不写任何数据。
// 放 edge-functions/api/d1probe.js，只部署测试站；测完删。
//   GET /api/d1probe?n=200   管理令牌（Authorization: Bearer <FEEDBACK_ADMIN_TOKEN>）才可调用
// 每次顺序请求，记毫秒；health＝只过 Worker，不碰 D1；status＝Worker＋读一次 D1；kv_get／kv_put＝同机 KV 对照（键 probe:tmp，TTL 60 秒）。
// 返回 { n, <项>: { ok, fail, p50, p90, p99, max } }，失败的不计入百分位。
import { checkAdminAuth, bearerToken, getKV } from './feedback.js';

const BASE = 'https://data.open-guji.com';
const pct = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor((a.length * p) / 100))] : null);

async function timeIt(fn) {
  const t0 = Date.now();
  try { await fn(); return { ms: Date.now() - t0 }; } catch (e) { return { err: String((e && e.message) || e).slice(0, 80) }; }
}
function stat(rs) {
  const ok = rs.filter((r) => r.ms !== undefined).map((r) => r.ms).sort((x, y) => x - y);
  const errs = [...new Set(rs.filter((r) => r.err).map((r) => r.err))].slice(0, 3);
  return { ok: ok.length, fail: rs.length - ok.length, p50: pct(ok, 50), p90: pct(ok, 90), p99: pct(ok, 99), max: ok.at(-1) ?? null, errs };
}

export async function onRequestGet(context) {
  const authed = checkAdminAuth(bearerToken(context.request), context);
  if (!authed.ok) return new Response(JSON.stringify({ error: authed.error }), { status: authed.status });
  const n = Math.min(Math.max(parseInt(new URL(context.request.url).searchParams.get('n') || '100', 10) || 100, 1), 300);
  const tok = bearerToken(context.request); // 复用同一管理令牌（Worker web 角色可读 /v1/status）
  const get = (path) => async () => {
    const r = await fetch(BASE + path, { headers: { Authorization: `Bearer ${tok}` } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    await r.text();
  };
  const kv = getKV(context);
  const out = { n, colo: context.request.headers.get('eo-connecting-region') || undefined };
  const runs = { health: [], status: [], kv_get: [], kv_put: [] };
  for (let i = 0; i < n; i++) {
    runs.health.push(await timeIt(get('/v1/health')));
    runs.status.push(await timeIt(get('/v1/status')));
    if (kv) {
      runs.kv_put.push(await timeIt(() => kv.put('probe:tmp', String(i), { expirationTtl: 60 })));
      runs.kv_get.push(await timeIt(() => kv.get('probe:tmp')));
    }
  }
  for (const k of Object.keys(runs)) if (runs[k].length) out[k] = stat(runs[k]);
  return new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
