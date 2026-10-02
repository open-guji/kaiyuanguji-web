// 站内搜索代理（EdgeOne Pages Function）：浏览器 → /api/search → Meilisearch。
//
// 为什么要这层（S1，2026-09-28）：
//   - Meili 地址与只读 key 不再下发到浏览器（以前 NEXT_PUBLIC_MEILI_KEY 编进前端 chunk）；
//   - 只放行白名单里的索引与参数，limit／offset 有上限；filter 里 `is_draft = false`（只搜正式条目）
//     由服务端写死、浏览器改不了；浏览器只能在它后面 AND 上受限的筛选（见下「filter」）；
//   - 结果在 isolate 内存与边缘 Cache API 各存一份（见下「缓存」）；以后换搜索后端只改这里，前端不动。
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
// locale（overview#342）：`locale=zh-Hans`（POST 体里同名字段）时，命中的显示字段（DISPLAY_FIELDS：书名、作者、朝代等）
//   在这里转简体，与 nextjs/src/lib/server/simplify.ts 同一套 opencc t2cn 字表——首页检索候选不引 opencc，靠它跟繁简偏好走。
//   不传或 zh-Hant 原样返回（结果页 L1 不传，行为不变）；其他值一律 400。缓存键带 locale。
// 返回：{ results: [{ indexUid, hits, estimatedTotalHits, limit, offset }] }
//   hits 只含卡片渲染要的字段；works/books 的 _formatted 只留 description_search（简介命中片段）。
// 失败：Meili 不可用／超时 → 503 { error, code }，前端据此退回浏览器兜底（L2）；手里有 24 小时内的旧结果时先给旧的（STALE）。
//
// 缓存（overview#353）：索引最多每晚重建一次（indexer/README.md），所以结果 10 分钟内算新鲜（HIT），
//   10 分钟～24 小时之间先回旧结果、后台（context.waitUntil）重取（STALE）；平台没有 waitUntil 时过了新鲜期就同步重取。
//   边缘缓存写入也走 waitUntil，不压在首个请求上；同一 isolate 里同一查询并发只打一次上游。浏览器侧 max-age 5 分钟。
//   响应头 X-Search-Cache：HIT／STALE／MISS／BYPASS。
// 观测（overview#353）：响应带 Server-Timing（DevTools「Timing」页可见，curl -D- 可看）：
//   parse 解析校验、cache 查内存＋边缘缓存、upstream 函数→Meili 往返（desc 为第几次请求）、
//   meili Meili 自报的 processingTimeMs（多条取最大）、total 函数内总耗时。upstream − meili ≈ 函数到源站的网络＋排队。
//
// 配置（EdgeOne 项目环境变量，经 context.env 读；E1 之后全栈项目在构建时烘进 context.env）：
//   MEILI_URL          Meili API base（不配则用 NEXT_PUBLIC_MEILI_URL，再不配用 DEFAULT_MEILI_URL）
//   MEILI_SEARCH_KEY   只读搜索 key（不配则用 NEXT_PUBLIC_MEILI_KEY——全栈项目构建环境里有它）
// 绝不放 master key：本函数只调 /multi-search。

import { Converter } from 'opencc-js/t2cn';

const DEFAULT_MEILI_URL = 'https://api.kaiyuanguji.com';

const ALLOWED_INDEXES = ['works', 'books', 'collections', 'entities'];
const MAX_LIMIT = 50;
const MAX_OFFSET = 1000; // Meili 默认 maxTotalHits
const MAX_QUERY_CHARS = 100;
const MAX_QUERIES = ALLOWED_INDEXES.length;
const UPSTREAM_TIMEOUT_MS = 2000;
// 新鲜期内直接给；过了新鲜期、在 STALE 期内先给旧的再后台刷新（见文件头「缓存」）
const CACHE_FRESH_SECONDS = 600;
const CACHE_STALE_SECONDS = 24 * 3600;
const BROWSER_MAX_AGE_SECONDS = 300;

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

// ─── 繁简（overview#342） ───

const LOCALES = ['zh-Hans', 'zh-Hant'];
/** 转简体的显示字段；classification、loss_status 等是筛选取值，不动 */
const DISPLAY_FIELDS = ['title', 'primary_name', 'author', 'dynasty', 'era', 'role', 'edition'];

// 与 nextjs/src/lib/server/simplify.ts 同口径：Converter({ from: 'tw', to: 'cn' })，isolate 内只建一次；建不成就原样返回
let t2cn;
function toSimplified(text) {
  if (t2cn === undefined) {
    try {
      t2cn = Converter({ from: 'tw', to: 'cn' });
    } catch {
      t2cn = null;
    }
  }
  if (!t2cn || !text) return text;
  try {
    return t2cn(text);
  } catch {
    return text;
  }
}

/** 要转简体时返回 'zh-Hans'，否则 null（原样）：zh-Hant 与不传等价，共用同一份缓存；只认 LOCALES 里的值 */
function parseLocale(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (!LOCALES.includes(raw)) throw new BadRequest('locale 只认 zh-Hans、zh-Hant');
  return raw === 'zh-Hans' ? raw : null;
}

function localizeResults(results, locale) {
  if (locale !== 'zh-Hans') return results;
  return results.map((r) => ({
    ...r,
    hits: r.hits.map((h) => {
      const out = { ...h };
      for (const k of DISPLAY_FIELDS) if (typeof out[k] === 'string') out[k] = toSimplified(out[k]);
      return out;
    }),
  }));
}

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

/** 从请求里解析出规整后的 queries 与 locale（GET 查询串或 POST multi-search 体） */
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
    return { queries: queries.map((q) => sanitizeQuery(q)), locale: parseLocale(body.locale) };
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
  const queries = uniq.map((indexUid) => sanitizeQuery({
    indexUid, q, limit: params.get('limit'), offset: params.get('offset'), filter: params.get('filter'), sort: params.get('sort'),
  }, defaultLimit));
  return { queries, locale: parseLocale(params.get('locale')) };
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

// ─── 缓存：isolate 内存 LRU ＋（有的话）边缘 Cache API；条目都是 { t: 写入时刻, body } ───

const memoryCache = new Map(); // key → { t, body }
const inflight = new Map(); // key → Promise<{ body, cacheable, timing }>

function cacheKey(queries, locale) {
  const key = JSON.stringify(queries.map((q) => [q.indexUid, q.q, q.limit, q.offset, buildFilterString(q.filter), q.sort]));
  // 不带 locale 的键保持原样：结果页现有缓存不受影响
  return locale ? `${locale}|${key}` : key;
}

function memoryGet(key, now) {
  const hit = memoryCache.get(key);
  if (!hit) return null;
  if (now - hit.t >= CACHE_STALE_SECONDS * 1000) {
    memoryCache.delete(key);
    return null;
  }
  // LRU：命中挪到末尾
  memoryCache.delete(key);
  memoryCache.set(key, hit);
  return hit;
}

function memorySet(key, entry) {
  memoryCache.set(key, entry);
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
  // 合成 GET 请求当缓存键：POST 与 GET 的同一查询共用一份。v2：条目带写入时刻（v1 是裸 body，不再读）
  return new Request(`https://search-cache.invalid/v2?k=${encodeURIComponent(key)}`);
}

async function edgeGet(key, now) {
  const cache = edgeCache();
  if (!cache) return null;
  try {
    const res = await cache.match(edgeCacheRequest(key));
    if (!res) return null;
    const entry = JSON.parse(await res.text());
    if (!entry || typeof entry.t !== 'number' || typeof entry.body !== 'string') return null;
    return now - entry.t < CACHE_STALE_SECONDS * 1000 ? entry : null;
  } catch {
    return null;
  }
}

async function edgePut(key, entry) {
  const cache = edgeCache();
  if (!cache) return;
  try {
    await cache.put(edgeCacheRequest(key), new Response(JSON.stringify(entry), {
      headers: { ...JSON_HEADERS, 'Cache-Control': `public, max-age=${CACHE_STALE_SECONDS}` },
    }));
  } catch {
    // 缓存失败不影响结果
  }
}

/** 把收尾活交给平台（响应先回）；没有 waitUntil 就当场等完 */
async function deferOrAwait(context, promise) {
  if (context && typeof context.waitUntil === 'function') {
    context.waitUntil(promise);
    return;
  }
  await promise;
}

// ─── Server-Timing ───

function clock() {
  return (typeof performance !== 'undefined' && performance && typeof performance.now === 'function')
    ? performance.now() : Date.now();
}

/** 收集 Server-Timing 条目：metric(name, dur, desc?) */
function serverTiming() {
  const start = clock();
  const items = [];
  return {
    start,
    add(name, dur, desc) {
      if (typeof dur === 'number' && Number.isFinite(dur)) items.push({ name, dur, desc });
    },
    since(t0) {
      return clock() - t0;
    },
    header() {
      const all = [...items, { name: 'total', dur: clock() - start }];
      return all.map((m) => `${m.name};${m.desc ? `desc="${m.desc}";` : ''}dur=${Math.round(m.dur * 10) / 10}`).join(', ');
    },
  };
}

/** Meili 自报的处理耗时：multi-search 每条一个 processingTimeMs，取最大 */
function meiliProcessingMs(meiliJson) {
  const results = Array.isArray(meiliJson && meiliJson.results) ? meiliJson.results : [];
  const ms = results.map((r) => r && r.processingTimeMs).filter((n) => typeof n === 'number');
  return ms.length ? Math.max(...ms) : undefined;
}

// ─── 上游 ───

class UpstreamError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function callMeili(config, queries, timing, attempt = 1) {
  const t0 = clock();
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
    if (!res.ok) {
      // 带上 Meili 的错误码（只在服务端用，不回传给浏览器）：sort 降级只认排序类错误
      let code;
      try {
        const err = await res.json();
        if (err && typeof err.code === 'string') code = err.code;
      } catch {
        // 上游没给 JSON 就没有 code
      }
      throw new UpstreamError(`HTTP ${res.status}`, res.status, code);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
    if (timing) timing.add('upstream', clock() - t0, String(attempt));
  }
}

function json(status, obj, extraHeaders = {}) {
  return new Response(typeof obj === 'string' ? obj : JSON.stringify(obj), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

const UNAVAILABLE_MESSAGE = '搜索服务暂时不可用，已切换到简易搜索（仅按书名、作者匹配）。';

/**
 * 打上游并规整出响应体。sort 降级的结果标 cacheable: false（不进缓存）；成功且可缓存的顺手写缓存
 * （内存当场写，边缘缓存交给 waitUntil）。上游失败抛 UpstreamError。
 */
async function loadFromUpstream(context, queries, locale, key, timing) {
  const config = getConfig(context);
  let meiliJson;
  let sortIgnored = false;
  try {
    meiliJson = await callMeili(config, queries, timing);
  } catch (e) {
    // 索引还没重建出可排序字段时 Meili 对 sort 回 400 + invalid_search_sort：去掉 sort 重发一次，按相关度出结果。
    // 只认排序类错误码——其它 400（filter 写错等）照常当失败，不能被降级悄悄吞掉
    if (e && e.status === 400 && typeof e.code === 'string' && e.code.startsWith('invalid_search_sort') && queries.some((q) => q.sort)) {
      sortIgnored = true;
      meiliJson = await callMeili(config, queries.map((q) => ({ ...q, sort: null })), timing, 2);
    } else {
      throw e;
    }
  }
  timing.add('meili', meiliProcessingMs(meiliJson));

  const shaped = localizeResults(shapeResults(meiliJson, queries), locale);
  if (sortIgnored) {
    // 降级结果（没排序）不进缓存：否则索引重建后一段时间内同一查询还会命中这份未排序的结果
    return { body: JSON.stringify({ results: shaped.map((r) => ({ ...r, sortIgnored: true })) }), cacheable: false };
  }
  const entry = { t: Date.now(), body: JSON.stringify({ results: shaped }) };
  memorySet(key, entry);
  await deferOrAwait(context, edgePut(key, entry));
  return { body: entry.body, cacheable: true };
}

/** 同一 isolate 里同一查询并发只打一次上游（热门词刚过期时一拥而上） */
function loadOnce(context, queries, locale, key, timing) {
  let p = inflight.get(key);
  if (!p) {
    p = loadFromUpstream(context, queries, locale, key, timing).finally(() => {
      if (inflight.get(key) === p) inflight.delete(key);
    });
    inflight.set(key, p);
  }
  return p;
}

// 只导出 onRequest* 两个处理函数（与本目录其余函数一致）；单测经它们走全链路、mock 全局 fetch
async function handleSearch(context) {
  const { request } = context;
  const timing = serverTiming();
  let queries;
  let locale;
  let t0 = clock();
  try {
    ({ queries, locale } = await parseQueries(request));
  } catch (e) {
    if (e instanceof BadRequest) return json(400, { error: e.message, code: 'bad_request' }, { 'Cache-Control': 'no-store' });
    throw e;
  }
  timing.add('parse', timing.since(t0));

  const okHeaders = (state) => ({
    'Cache-Control': `public, max-age=${BROWSER_MAX_AGE_SECONDS}`,
    'X-Search-Cache': state,
    'Server-Timing': timing.header(),
  });

  // 空查询：不打上游（Meili 空 q 会返回全表占位结果）
  if (queries.every((q) => !q.q)) {
    return json(200, { results: shapeResults({ results: [] }, queries) }, okHeaders('EMPTY'));
  }

  const key = cacheKey(queries, locale);
  const now = Date.now();
  t0 = clock();
  let entry = memoryGet(key, now);
  if (!entry) {
    entry = await edgeGet(key, now);
    if (entry) memorySet(key, entry);
  }
  timing.add('cache', timing.since(t0));

  const canDefer = !!(context && typeof context.waitUntil === 'function');
  if (entry) {
    const age = now - entry.t;
    if (age < CACHE_FRESH_SECONDS * 1000) return json(200, entry.body, okHeaders('HIT'));
    if (canDefer) {
      // 先给旧的，后台刷新；刷新失败不影响这次响应（旧的还能撑到 STALE 期满）
      context.waitUntil(loadOnce(context, queries, locale, key, serverTiming()).catch(() => {}));
      return json(200, entry.body, okHeaders('STALE'));
    }
  }

  let loaded;
  try {
    loaded = await loadOnce(context, queries, locale, key, timing);
  } catch (e) {
    // 上游挂了但手里有 STALE 期内的旧结果：先给旧的，比退回简易搜索强
    if (entry) return json(200, entry.body, okHeaders('STALE'));
    const status = e && e.status;
    const code = (status === 401 || status === 403) ? 'upstream_auth' : 'upstream_unavailable';
    // 不回传上游地址与原始报错，只给代码与提示
    return json(503, { error: UNAVAILABLE_MESSAGE, code }, { 'Cache-Control': 'no-store', 'Retry-After': '30', 'Server-Timing': timing.header() });
  }
  if (!loaded.cacheable) {
    return json(200, loaded.body, { 'Cache-Control': 'no-store', 'X-Search-Cache': 'BYPASS', 'Server-Timing': timing.header() });
  }
  return json(200, loaded.body, okHeaders('MISS'));
}

export async function onRequestGet(context) {
  return handleSearch(context);
}

export async function onRequestPost(context) {
  return handleSearch(context);
}
