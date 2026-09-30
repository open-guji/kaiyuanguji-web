// 站内搜索代理（EdgeOne Pages Function）：浏览器 → /api/search → Meilisearch。
//
// 为什么要这层（S1，2026-09-28）：
//   - Meili 地址与只读 key 不再下发到浏览器（以前 NEXT_PUBLIC_MEILI_KEY 编进前端 chunk）；
//   - 只放行白名单里的索引与参数，limit／offset 有上限；filter 里 `is_draft = false`（只搜正式条目）
//     由服务端写死、浏览器改不了；浏览器只能在它后面 AND 上受限的筛选（见下「filter」）；
//   - 热门查询在边缘缓存 60 秒；以后换搜索后端只改这里，前端不动。
//
// 接口（只读）：
//   GET  /api/search?q=史記&limit=5                  → 四类索引各搜一次（首页分组结果）
//   GET  /api/search?q=史記&index=works&limit=20&offset=40   → 单一索引（翻页）
//   GET  /api/search?q=史記&indexes=works,books      → 指定若干索引
//   GET  /api/search?q=史記&index=works&filter=dynasty IN ["唐","宋"] AND classification = "史部"
//        → 筛选（搜索页 v4 的朝代／部类／资源／存佚，overview#291 P1a），见下「filter」
//   POST /api/search  {"queries":[{"indexUid":"works","q":"史記","limit":5,"offset":0,"filter":"has_image = true"}]}
//        → 与 Meili multi-search 同形（每条 query 同样过白名单，其余字段一律丢弃）
//
// filter（只读、受限的子集，不是把 Meili 的过滤串透传）：
//   语法：clause (AND clause)*；clause 是 `字段 = "值"`、`字段 IN ["值", …]`（同一字段多选，OR），布尔字段是 `字段 = true|false`。
//   字段按索引限定（FILTER_FIELDS）：works 可筛 type／dynasty／classification／loss_status／has_image／has_text／has_collated，
//   其余索引更少；碰到白名单外的字段（含 is_draft）、语法不对、超长（FILTER_MAX_CHARS）、条数过多（FILTER_MAX_CLAUSES／
//   FILTER_MAX_IN_VALUES）、同一字段出现两次，一律 400 bad_request，不会悄悄丢掉再放行（悄悄丢掉会让用户看到「筛了但没筛」）。
//   解析后按 AST 重新拼串再发给 Meili（值用 JSON.stringify），原串不会到上游；`is_draft = false` 永远排在最前。
//   空串值表示「该字段为空」（如 classification = "" ＝ 未分類），代理改写成 Meili 的 IS EMPTY（`= ""` 在 Meili 里筛不到空值）。
//   sort：只认 era:asc|desc（按年代）、title:asc|desc（按书名），只对 works／books／entities；见 SORT_MAP。
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

// filter 的限额与字段白名单（'s' = 字符串字段，'b' = 布尔字段）。字段必须是该索引的 filterableAttributes
// （indexer/full-reindex.mjs 的 SETTINGS），否则 Meili 会 400；is_draft 不在其中，由服务端强制。
const FILTER_MAX_CHARS = 700;
const FILTER_MAX_CLAUSES = 6;
// 朝代分组（搜索页 v4）展开成 30+ 个取值，IN 上限与总长按它放宽（2026-09-30，overview#298）
const FILTER_MAX_IN_VALUES = 40;
const FILTER_MAX_VALUE_CHARS = 20;
const FILTER_FIELDS = {
  works: { type: 's', dynasty: 's', classification: 's', loss_status: 's', has_image: 'b', has_text: 'b', has_collated: 'b' },
  books: { type: 's', dynasty: 's', has_image: 'b', has_text: 'b' },
  collections: { type: 's' },
  entities: { type: 's', dynasty: 's' },
};
// sort（搜索页 v4「按年代／按书名」）：对外只认这四个键，翻译成索引里的可排序字段；
// collections 没有这两个字段，带 sort 一律 400。索引重建前没有这些可排序字段，Meili 会 400，
// 代理这时去掉 sort 重发（结果按相关度，响应里 sortIgnored: true），不让搜索页整页报错。
const SORT_MAP = {
  'era:asc': 'era_rank:asc',
  'era:desc': 'era_rank:desc',
  'title:asc': 'title_sort:asc',
  'title:desc': 'title_sort:desc',
};
const SORT_INDEXES = new Set(['works', 'books', 'entities']);
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
  // 搜索页 v4 表格的「部类」列与存佚（只 works 有，重建索引后才出现）
  'classification', 'loss_status',
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


// ─── filter：受限语法的解析与重组 ───

/** 词法：标识符、双引号字符串、[ ] , = ；字符串里不许有反斜杠、引号、控制字符（不做转义，直接拒） */
function tokenizeFilter(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '[' || c === ']' || c === ',' || c === '=') { tokens.push({ t: c }); i++; continue; }
    if (c === '"') {
      let j = i + 1;
      let str = '';
      while (j < src.length && src[j] !== '"') {
        const ch = src[j];
        // eslint-disable-next-line no-control-regex
        if (ch === '\\' || /[\u0000-\u001f\u007f]/.test(ch)) throw new BadRequest('filter 的值里有不允许的字符');
        str += ch;
        j++;
      }
      if (j >= src.length) throw new BadRequest('filter 引号没有闭合');
      if (Array.from(str).length > FILTER_MAX_VALUE_CHARS) throw new BadRequest(`filter 的值过长（上限 ${FILTER_MAX_VALUE_CHARS} 字）`);
      tokens.push({ t: 'str', v: str });
      i = j + 1;
      continue;
    }
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (m) { tokens.push({ t: 'id', v: m[0] }); i += m[0].length; continue; }
    throw new BadRequest('filter 语法不对');
  }
  return tokens;
}

/**
 * 解析 filter 串 → 规整后的 clause 列表 [{ field, op: 'eq'|'in', values: [...] }]；空串／缺省返回 []。
 * 字段按 indexUid 限定，值的类型按字段类型限定。
 */
function parseFilter(raw, indexUid) {
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== 'string') throw new BadRequest('filter 须为字符串');
  if (!raw.trim()) return [];
  if (Array.from(raw).length > FILTER_MAX_CHARS) throw new BadRequest(`filter 过长（上限 ${FILTER_MAX_CHARS} 字）`);
  const fields = FILTER_FIELDS[indexUid] || {};
  const tokens = tokenizeFilter(raw);
  let p = 0;
  const peek = () => tokens[p];
  const take = () => tokens[p++];
  const kw = (tok, word) => tok && tok.t === 'id' && tok.v.toUpperCase() === word;
  const clauses = [];
  const seen = new Set();
  for (;;) {
    const f = take();
    if (!f || f.t !== 'id') throw new BadRequest('filter 语法不对');
    const kind = fields[f.v];
    if (!kind) throw new BadRequest(`该索引不支持按 ${f.v.slice(0, 30)} 过滤`);
    if (seen.has(f.v)) throw new BadRequest(`filter 里 ${f.v} 出现了不止一次`);
    seen.add(f.v);
    const op = take();
    let values;
    let opName;
    if (op && op.t === '=') {
      opName = 'eq';
      const v = take();
      if (kind === 'b') {
        if (!v || v.t !== 'id' || !/^(true|false)$/i.test(v.v)) throw new BadRequest(`${f.v} 只能等于 true 或 false`);
        values = [v.v.toLowerCase() === 'true'];
      } else {
        if (!v || v.t !== 'str') throw new BadRequest(`${f.v} 的值须为带双引号的字符串`);
        values = [v.v];
      }
    } else if (kw(op, 'IN')) {
      if (kind === 'b') throw new BadRequest(`${f.v} 不支持 IN`);
      opName = 'in';
      if (!take() || tokens[p - 1].t !== '[') throw new BadRequest('IN 后须为 [ … ]');
      values = [];
      for (;;) {
        const v = take();
        if (!v || v.t !== 'str') throw new BadRequest(`${f.v} 的值须为带双引号的字符串`);
        values.push(v.v);
        const sep = take();
        if (sep && sep.t === ',') continue;
        if (sep && sep.t === ']') break;
        throw new BadRequest('filter 语法不对');
      }
      if (values.length > FILTER_MAX_IN_VALUES) throw new BadRequest(`IN 至多 ${FILTER_MAX_IN_VALUES} 个值`);
    } else {
      throw new BadRequest('filter 语法不对');
    }
    clauses.push({ field: f.v, op: opName, values });
    if (clauses.length > FILTER_MAX_CLAUSES) throw new BadRequest(`filter 至多 ${FILTER_MAX_CLAUSES} 个条件`);
    const next = peek();
    if (next === undefined) break;
    if (!kw(next, 'AND')) throw new BadRequest('filter 语法不对（条件之间只能用 AND）');
    take();
  }
  return clauses;
}

/**
 * clause 列表 → 发给 Meili 的过滤串；is_draft = false 永远在最前，值一律 JSON.stringify（不含原串）。
 *
 * 空串值（如 classification = ""，表示「没有部类」＝未分類）要改写：Meili 1.12 里 `field = ""` 永远筛不到
 * 空值（2026-09-30 用本机 Meili v1.12.8 实测），得写 `field IS EMPTY`。所以前端照索引里的值用 ""，
 * 代理负责翻译：`= ""` → `IS EMPTY`；`IN ["史部", ""]` → `(field IN ["史部"] OR field IS EMPTY)`。
 */
function buildFilterString(clauses) {
  const parts = ['is_draft = false'];
  for (const c of clauses) {
    if (typeof c.values[0] === 'boolean') {
      parts.push(`${c.field} = ${String(c.values[0])}`);
      continue;
    }
    const nonEmpty = c.values.filter((v) => v !== '');
    const hasEmpty = nonEmpty.length !== c.values.length;
    const valuePart = nonEmpty.length === 1 && c.op === 'eq'
      ? `${c.field} = ${JSON.stringify(nonEmpty[0])}`
      : `${c.field} IN [${nonEmpty.map((v) => JSON.stringify(v)).join(', ')}]`;
    if (!hasEmpty) parts.push(valuePart);
    else if (!nonEmpty.length) parts.push(`${c.field} IS EMPTY`);
    else parts.push(`(${valuePart} OR ${c.field} IS EMPTY)`);
  }
  return parts.join(' AND ');
}

/**
 * 把一条外来 query 规整成可发给 Meili 的形状。只认 indexUid/q/limit/offset/filter，
 * 其余参数（attributesToRetrieve、sort……）一律丢弃，由服务端写死；filter 走 parseFilter 的受限语法。
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
  const filter = parseFilter(raw.filter, indexUid);
  const sort = parseSort(raw.sort, indexUid);
  return { indexUid, q, limit, offset, filter, sort };
}

/** sort 参数 → 索引里的排序键（如 'era_rank:asc'）；缺省返回 null；不认识／该索引不支持一律 400 */
function parseSort(raw, indexUid) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || !Object.prototype.hasOwnProperty.call(SORT_MAP, raw)) throw new BadRequest('sort 只认 era:asc|desc、title:asc|desc');
  if (!SORT_INDEXES.has(indexUid)) throw new BadRequest(`${indexUid} 索引不支持 sort`);
  return SORT_MAP[raw];
}

/** 规整后的 query → Meili multi-search 里的一条（服务端写死 filter／字段／高亮） */
function toMeiliQuery(sq) {
  const out = {
    indexUid: sq.indexUid,
    q: sq.q,
    limit: sq.limit,
    offset: sq.offset,
    // 网站搜索只暴露 production 条目（2026-09 draft 混入回归）；is_draft = false 前端不可改，
    // 后面只会跟 parseFilter 校验过的筛选
    filter: buildFilterString(sq.filter),
    attributesToRetrieve: ATTRIBUTES_TO_RETRIEVE,
  };
  if (sq.sort) out.sort = [sq.sort];
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
    indexUid, q, limit: params.get('limit'), offset: params.get('offset'), filter: params.get('filter'), sort: params.get('sort'),
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
  return JSON.stringify(queries.map((q) => [q.indexUid, q.q, q.limit, q.offset, buildFilterString(q.filter), q.sort]));
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
  let sortIgnored = false;
  try {
    try {
      meiliJson = await callMeili(config, queries);
    } catch (e) {
      // 索引还没重建出可排序字段时 Meili 对 sort 回 400：去掉 sort 重发一次，按相关度出结果
      if (e && e.status === 400 && queries.some((q) => q.sort)) {
        sortIgnored = true;
        meiliJson = await callMeili(config, queries.map((q) => ({ ...q, sort: null })));
      } else {
        throw e;
      }
    }
  } catch (e) {
    const status = e && e.status;
    const code = (status === 401 || status === 403) ? 'upstream_auth' : 'upstream_unavailable';
    // 不回传上游地址与原始报错，只给代码与提示
    return json(503, { error: UNAVAILABLE_MESSAGE, code }, { 'Cache-Control': 'no-store', 'Retry-After': '30' });
  }

  const shaped = shapeResults(meiliJson, queries);
  const body = JSON.stringify({ results: sortIgnored ? shaped.map((r) => ({ ...r, sortIgnored: true })) : shaped });
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
