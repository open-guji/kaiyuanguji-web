// 站内搜索代理（EdgeOne Pages Function）：浏览器 → /api/search → Meilisearch。
//
// 为什么要这层（S1，2026-09-28）：
//   - Meili 地址与只读 key 不再下发到浏览器（以前 NEXT_PUBLIC_MEILI_KEY 编进前端 chunk）；
//   - 只放行白名单里的索引与参数，limit／offset 有上限，filter 由服务端写死（只搜正式条目），
//     浏览器改不了；
//   - 热门查询在边缘缓存 60 秒；以后换搜索后端只改这里，前端不动。
//
// 接口（只读）：
//   GET  /api/search?q=史記&limit=5                  → 四类索引各搜一次（首页分组结果）
//   GET  /api/search?q=史記&index=works&limit=20&offset=40   → 单一索引（翻页）
//   GET  /api/search?q=史記&indexes=works,books      → 指定若干索引
//   POST /api/search  {"queries":[{"indexUid":"works","q":"史記","limit":5,"offset":0}]}
//        → 与 Meili multi-search 同形（每条 query 同样过白名单，其余字段一律丢弃）
// 返回：{ results: [{ indexUid, hits, estimatedTotalHits, limit, offset }] }
//   hits 只含卡片渲染要的字段；works/books 的 _formatted 只留 description_search（简介命中片段）。
// 失败：Meili 不可用／超时 → 503 { error, code }，前端据此退回浏览器兜底（L2）。
//
// 配置（EdgeOne 项目环境变量，经 context.env 读；E1 之后全栈项目在构建时烘进 context.env）：
//   MEILI_URL          Meili API base（不配则用 NEXT_PUBLIC_MEILI_URL，再不配用 DEFAULT_MEILI_URL）
//   MEILI_SEARCH_KEY   只读搜索 key（不配则用 NEXT_PUBLIC_MEILI_KEY——全栈项目构建环境里有它）
// 绝不放 master key：本函数只调 /multi-search。

const DEFAULT_MEILI_URL = 'https://api.kaiyuanguji.com';

const ALLOWED_INDEXES = ['works', 'books', 'collections', 'entities'];
const MAX_LIMIT = 50;
const MAX_OFFSET = 1000; // Meili 默认 maxTotalHits
const MAX_QUERY_CHARS = 100;
const MAX_QUERIES = ALLOWED_INDEXES.length;
const UPSTREAM_TIMEOUT_MS = 2000;
const CACHE_TTL_SECONDS = 60;
const MEMORY_CACHE_MAX = 500;

// 只有 works/books 有 description_search（见 indexer/full-reindex.mjs 的 SETTINGS）
const DESCRIPTION_HIGHLIGHT_INDEXES = new Set(['works', 'books']);
const DESCRIPTION_CROP_LENGTH = 80;
// 与 book-index-ui 的 SNIPPET_MARK_START／END 一致：控制字符作高亮标记，前端按它切段渲染
const HIGHLIGHT_PRE = '\u0001';
const HIGHLIGHT_POST = '\u0002';
// 前端 meili-storage.ts 的 hitToEntry 用到的字段；其余（*_search、completeness 等）不外传
const ATTRIBUTES_TO_RETRIEVE = [
  'id', 'type', 'is_draft', 'title', 'primary_name', 'author', 'dynasty', 'era', 'sort_year',
  'role', 'edition', 'subtype', 'juan_count', 'has_text', 'has_image', 'has_collated',
  'birth_year', 'death_year', 'cbdb_id',
];

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };

// 与 feedback.js / track-error.js 同样：先 context.env，再全局标识符
function readEnv(context, name) {
  if (context && context.env && context.env[name]) return String(context.env[name]);
  const g = globalThis[name];
  return g ? String(g) : '';
}

function getConfig(context) {
  const baseUrl = readEnv(context, 'MEILI_URL') || readEnv(context, 'NEXT_PUBLIC_MEILI_URL') || DEFAULT_MEILI_URL;
  const apiKey = readEnv(context, 'MEILI_SEARCH_KEY') || readEnv(context, 'NEXT_PUBLIC_MEILI_KEY');
  return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey };
}

class BadRequest extends Error {}

function toInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = typeof value === 'number' ? value : Number(String(value));
  if (!Number.isFinite(n)) throw new BadRequest('limit/offset 须为数字');
  return Math.trunc(n);
}

/**
 * 把一条外来 query 规整成可发给 Meili 的形状。只认 indexUid/q/limit/offset，
 * 其余参数（filter、attributesToRetrieve、sort……）一律丢弃，由服务端写死。
 */
function sanitizeQuery(raw, defaultLimit = 5) {
  if (!raw || typeof raw !== 'object') throw new BadRequest('query 须为对象');
  const indexUid = raw.indexUid;
  if (!ALLOWED_INDEXES.includes(indexUid)) throw new BadRequest(`不支持的索引：${String(indexUid).slice(0, 40)}`);
  if (typeof raw.q !== 'string') throw new BadRequest('缺少 q');
  const q = raw.q.trim();
  if (Array.from(q).length > MAX_QUERY_CHARS) throw new BadRequest(`查询过长（上限 ${MAX_QUERY_CHARS} 字）`);
  const limit = Math.min(MAX_LIMIT, Math.max(1, toInt(raw.limit, defaultLimit)));
  const offset = Math.min(MAX_OFFSET, Math.max(0, toInt(raw.offset, 0)));
  return { indexUid, q, limit, offset };
}

/** 规整后的 query → Meili multi-search 里的一条（服务端写死 filter／字段／高亮） */
function toMeiliQuery(sq) {
  const out = {
    indexUid: sq.indexUid,
    q: sq.q,
    limit: sq.limit,
    offset: sq.offset,
    // 网站搜索只暴露 production 条目（2026-09 draft 混入回归）；前端不可改
    filter: 'is_draft = false',
    attributesToRetrieve: ATTRIBUTES_TO_RETRIEVE,
  };
  if (DESCRIPTION_HIGHLIGHT_INDEXES.has(sq.indexUid)) {
    out.attributesToHighlight = ['description_search'];
    out.attributesToCrop = ['description_search'];
    out.cropLength = DESCRIPTION_CROP_LENGTH;
    out.highlightPreTag = HIGHLIGHT_PRE;
    out.highlightPostTag = HIGHLIGHT_POST;
  }
  return out;
}

/** 从请求里解析出规整后的 queries（GET 查询串或 POST multi-search 体） */
async function parseQueries(request) {
  if (request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      throw new BadRequest('请求体须为 JSON');
    }
    const queries = body && body.queries;
    if (!Array.isArray(queries) || queries.length === 0) throw new BadRequest('queries 须为非空数组');
    if (queries.length > MAX_QUERIES) throw new BadRequest(`queries 至多 ${MAX_QUERIES} 条`);
    return queries.map((q) => sanitizeQuery(q));
  }
  const params = new URL(request.url).searchParams;
  const q = params.get('q');
  if (q === null) throw new BadRequest('缺少 q');
  const index = params.get('index');
  const indexes = index ? [index]
    : params.get('indexes') ? params.get('indexes').split(',').map((s) => s.trim()).filter(Boolean)
    : ALLOWED_INDEXES;
  if (indexes.length > MAX_QUERIES) throw new BadRequest(`indexes 至多 ${MAX_QUERIES} 个`);
  // 单索引（翻页）默认 20 条，分组首页默认 5 条
  const defaultLimit = index ? 20 : 5;
  const uniq = [...new Set(indexes)];
  return uniq.map((indexUid) => sanitizeQuery({
    indexUid, q, limit: params.get('limit'), offset: params.get('offset'),
  }, defaultLimit));
}

/** Meili 返回 → 对外结果：只留白名单字段，_formatted 只留简介片段 */
function shapeResults(meiliJson, queries) {
  const results = Array.isArray(meiliJson && meiliJson.results) ? meiliJson.results : [];
  return queries.map((sq, i) => {
    const r = results[i] || {};
    const hits = (Array.isArray(r.hits) ? r.hits : []).map((h) => {
      const hit = {};
      for (const k of ATTRIBUTES_TO_RETRIEVE) if (h[k] !== undefined) hit[k] = h[k];
      const snippet = h._formatted && h._formatted.description_search;
      if (typeof snippet === 'string' && snippet) hit._formatted = { description_search: snippet };
      return hit;
    });
    return {
      indexUid: sq.indexUid,
      hits,
      estimatedTotalHits: typeof r.estimatedTotalHits === 'number' ? r.estimatedTotalHits : hits.length,
      limit: sq.limit,
      offset: sq.offset,
    };
  });
}

// ─── 缓存：isolate 内存 LRU ＋（有的话）边缘 Cache API ───

const memoryCache = new Map(); // key → { expires, body }

function cacheKey(queries) {
  return JSON.stringify(queries.map((q) => [q.indexUid, q.q, q.limit, q.offset]));
}

function memoryGet(key, now) {
  const hit = memoryCache.get(key);
  if (!hit) return null;
  if (hit.expires <= now) {
    memoryCache.delete(key);
    return null;
  }
  // LRU：命中挪到末尾
  memoryCache.delete(key);
  memoryCache.set(key, hit);
  return hit.body;
}

function memorySet(key, body, now) {
  memoryCache.set(key, { expires: now + CACHE_TTL_SECONDS * 1000, body });
  while (memoryCache.size > MEMORY_CACHE_MAX) {
    memoryCache.delete(memoryCache.keys().next().value);
  }
}

function edgeCache() {
  try {
    return (typeof caches !== 'undefined' && caches && caches.default) ? caches.default : null;
  } catch {
    return null;
  }
}

function edgeCacheRequest(key) {
  // 合成 GET 请求当缓存键：POST 与 GET 的同一查询共用一份
  return new Request(`https://search-cache.invalid/v1?k=${encodeURIComponent(key)}`);
}

async function edgeGet(key) {
  const cache = edgeCache();
  if (!cache) return null;
  try {
    const res = await cache.match(edgeCacheRequest(key));
    return res ? await res.text() : null;
  } catch {
    return null;
  }
}

async function edgePut(key, body) {
  const cache = edgeCache();
  if (!cache) return;
  try {
    await cache.put(edgeCacheRequest(key), new Response(body, {
      headers: { ...JSON_HEADERS, 'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}` },
    }));
  } catch {
    // 缓存失败不影响结果
  }
}

// ─── 上游 ───

class UpstreamError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function callMeili(config, queries) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    let res;
    try {
      res = await fetch(`${config.baseUrl}/multi-search`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({ queries: queries.map(toMeiliQuery) }),
      });
    } catch (e) {
      const timedOut = ctrl.signal.aborted;
      throw new UpstreamError(timedOut ? 'timeout' : `fetch failed: ${e && e.message}`, timedOut ? 504 : 502);
    }
    if (!res.ok) throw new UpstreamError(`HTTP ${res.status}`, res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function json(status, obj, extraHeaders = {}) {
  return new Response(typeof obj === 'string' ? obj : JSON.stringify(obj), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

const UNAVAILABLE_MESSAGE = '搜索服务暂时不可用，已切换到简易搜索（仅按书名、作者匹配）。';

// 只导出 onRequest* 两个处理函数（与本目录其余函数一致）；单测经它们走全链路、mock 全局 fetch
async function handleSearch(context) {
  const { request } = context;
  let queries;
  try {
    queries = await parseQueries(request);
  } catch (e) {
    if (e instanceof BadRequest) return json(400, { error: e.message, code: 'bad_request' }, { 'Cache-Control': 'no-store' });
    throw e;
  }

  // 空查询：不打上游（Meili 空 q 会返回全表占位结果）
  if (queries.every((q) => !q.q)) {
    return json(200, { results: shapeResults({ results: [] }, queries) }, { 'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}` });
  }

  const key = cacheKey(queries);
  const now = Date.now();
  const okHeaders = (state) => ({
    'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
    'X-Search-Cache': state,
  });

  const mem = memoryGet(key, now);
  if (mem) return json(200, mem, okHeaders('HIT'));
  const edge = await edgeGet(key);
  if (edge) {
    memorySet(key, edge, now);
    return json(200, edge, okHeaders('HIT'));
  }

  const config = getConfig(context);
  let meiliJson;
  try {
    meiliJson = await callMeili(config, queries);
  } catch (e) {
    const status = e && e.status;
    const code = (status === 401 || status === 403) ? 'upstream_auth' : 'upstream_unavailable';
    // 不回传上游地址与原始报错，只给代码与提示
    return json(503, { error: UNAVAILABLE_MESSAGE, code }, { 'Cache-Control': 'no-store', 'Retry-After': '30' });
  }

  const body = JSON.stringify({ results: shapeResults(meiliJson, queries) });
  memorySet(key, body, now);
  await edgePut(key, body);
  return json(200, body, okHeaders('MISS'));
}

export async function onRequestGet(context) {
  return handleSearch(context);
}

export async function onRequestPost(context) {
  return handleSearch(context);
}
