/**
 * 新旧架构对比的 HTTP 采样（任务书 §六）。每轮 A 探测顺带跑一次：
 *   · 每个目标 × 每类页面（首页／条目页×10 个 id／全文页）记 首字节时间、总耗时、状态、CDN 命中；
 *   · 搜索接口两边前端都直连 api.kaiyuanguji.com，是同一个后端，记在 target=shared 下；
 *   · 不告警的目标（新站）另跑一遍适用的 A 类检查，结果只进样本。
 * 注意：旧站是静态壳，HTML 里没有条目内容（浏览器再去数据桶取）；新站 /item 是服务端直出。
 * 所以 HTTP 层的数只比「文档本身」，用户真正看到内容的快慢看浏览器指标（LCP），见 browser-vitals.mjs。
 */
import { homePage, itemPages, edgeFunctions, tlsCerts } from './probe.mjs';
import { COMPARE_IDS } from '../perf-config.mjs';

const CACHE_HEADERS = ['eo-cache-status', 'x-cache', 'cf-cache-status', 'x-nextjs-cache', 'x-vercel-cache', 'age'];

/** 取一个 URL：首字节时间（fetch 拿到响应头）与读完 body 的总耗时 */
export async function measure(url, { timeoutMs = 20000, method = 'GET', headers = {}, body } = {}) {
  const t0 = performance.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method, body, redirect: 'manual', signal: ac.signal,
      headers: { 'user-agent': 'kaiyuanguji-monitor/1 (+github actions; compare)', ...headers },
    });
    const ttfb = performance.now() - t0;
    const buf = await res.arrayBuffer();
    const total = performance.now() - t0;
    const cache = {};
    for (const h of CACHE_HEADERS) { const v = res.headers.get(h); if (v != null) cache[h] = v; }
    return {
      status: res.status, ok: res.status >= 200 && res.status < 400,
      ttfb: Math.round(ttfb), total: Math.round(total), bytes: buf.byteLength,
      cache, hit: cacheHit(cache),
    };
  } catch (e) {
    return { status: 0, ok: false, ttfb: null, total: Math.round(performance.now() - t0), bytes: 0, cache: {}, hit: null,
      error: e?.name === 'AbortError' ? `超时 ${timeoutMs}ms` : (e?.cause?.code || e?.message) };
  } finally {
    clearTimeout(timer);
  }
}

/** 从各家 CDN 的头里判断是否命中缓存：true／false／null（看不出来） */
export function cacheHit(cache) {
  const vals = ['eo-cache-status', 'x-cache', 'cf-cache-status', 'x-nextjs-cache', 'x-vercel-cache']
    .map((h) => cache[h]).filter(Boolean).join(' ');
  if (/\b(HIT|STALE|REVALIDATED|UPDATING)\b/i.test(vals)) return true;
  if (/\b(MISS|EXPIRED|BYPASS|DYNAMIC|NONE)\b/i.test(vals)) return false;
  if (cache.age != null && Number(cache.age) > 0) return true;
  return null;
}

export function expandPages(target, ids = COMPARE_IDS) {
  const out = [];
  for (const [kind, tpl] of Object.entries(target.pages)) {
    if (tpl.includes('{id}')) for (const { id } of ids) out.push({ kind, id, path: tpl.replace('{id}', id) });
    else out.push({ kind, id: null, path: tpl });
  }
  return out;
}

/**
 * 跑一轮采样。每个目标内部串行（不自己给自己加压），目标之间并行。
 * @returns 样本数组
 */
export async function samplePerf({ cfg, targets, now, measureFn = measure }) {
  const t = new Date(now).toISOString();
  // 单请求上限 10 秒；连续 2 次连不上（status 0）就认定该目标本轮不可达，余下页面记为跳过，
  // 免得一个挂死的新站把 5 分钟的 job 拖超时、连累 A 类告警
  const timeoutMs = Math.min(cfg.timeoutMs, 10000);
  const perTarget = targets.map(async (tg) => {
    const rows = [];
    let dead = 0;
    for (const p of expandPages(tg)) {
      const base = { t, target: tg.name, kind: p.kind, id: p.id, path: p.path };
      if (dead >= 2) {
        rows.push({ ...base, status: 0, ok: false, ttfb: null, total: null, bytes: 0, cache: {}, hit: null, skipped: true, error: '前两次连不上，本轮余下跳过' });
        continue;
      }
      const m = await measureFn(tg.base + p.path, { timeoutMs });
      dead = m.status === 0 ? dead + 1 : 0;
      rows.push({ ...base, ...m });
    }
    return rows;
  });
  const search = (async () => {
    const m = await measureFn(`${cfg.api}/indexes/works/search`, {
      method: 'POST', timeoutMs: cfg.timeoutMs,
      headers: { authorization: `Bearer ${cfg.meiliKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ q: cfg.searchQuery, limit: 20, filter: 'is_draft = false' }),
    });
    return [{ t, target: 'shared', kind: 'search', id: null, path: '/indexes/works/search', ...m }];
  })();
  return (await Promise.all([...perTarget, search])).flat();
}

/**
 * 不告警的目标：跑一遍对它适用的 A 类检查（首页、条目页、边缘函数、证书），只进样本不开单。
 * 条目页检查里「测试站 /item」那一项此时就打这个目标自己的 /item。
 */
export async function shadowChecks({ cfg, target, ctx }) {
  const host = new URL(target.base).host;
  const shadowCfg = { ...cfg, www: target.base, staging: target.base, tlsHosts: [host] };
  const sctx = { ...ctx, cfg: shadowCfg, memo: {} };
  const fns = [homePage, itemPages, edgeFunctions, tlsCerts];
  const t = new Date(ctx.now).toISOString();
  const results = await Promise.all(fns.map(async (fn) => {
    try { return await fn(sctx); } catch (e) { return { id: fn.name, status: 'fail', parts: [{ label: '检查自身出错', status: 'fail', value: String(e) }] }; }
  }));
  return results.map((r) => ({
    t, target: target.name, kind: 'check', id: r.id, status: r.status, ok: r.status !== 'fail',
    failed: r.parts.filter((p) => p.status === 'fail').map((p) => `${p.label}：${p.value}`),
  }));
}
