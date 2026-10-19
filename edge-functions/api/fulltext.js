// 全文搜索代理（EdgeOne Pages Function）：浏览器 → /api/fulltext → 上海搜索机上的全文检索服务（fulltext/service/）。
//
// 为什么要这层：
//   - 源站地址与令牌只在服务端：浏览器看不到搜索机 IP／端口，也拿不到 X-FT-Token；
//   - 参数白名单与范围校验在边缘先做一遍（与契约 F1 同，fulltext/docs/design.md 第六节），不合法的不打上游；
//   - 全局开关（见下「开关」）：全文搜索还不太稳，服务出问题时要能一下子把前后端一起关掉、入口隐藏，且不必重新构建发布；
//   - 按 IP 限流、结果缓存（isolate 内存＋边缘 Cache API），护住只有 2 核的搜索机。
//
// 接口（只读，GET）：
//   GET /api/fulltext?op=status
//       → 200 { enabled: bool, reason?: string }，Cache-Control: public, max-age=30。前端挂载时先查它，enabled 为真才显示「全文」tab。
//   GET /api/fulltext?q=學而時習之&mode=fuzzy&group=book&limit=10&offset=0&per_book=3&entry=
//       → 透传上游的 F1 响应（样例 fulltext/contract/sample_response.json）。
//       参数白名单（其余参数一律丢弃，不到上游）：
//         q         必填、去掉首尾空白后不能为空；超过 60 字的截断交给上游（上游回 truncated:true）。
//                   这里只截到 61 个码点：上游看到的前 60 字与是否超长都不变，缓存键却有了上限。
//         mode      fuzzy|exact|near（near＝差一字：多一字、少一字、错一字，≥4 字才放宽；group 多 exact_count）
//         group     book|none
//         limit     1..50              offset    0..MAX_OFFSET（10000）
//         per_book  1..20              entry     只许字母数字（1..32 位）
//       不合法 → 400 { error: 'bad_query', message }。
//
// 开关（全局，不用重新构建）：
//   1) 环境变量 FULLTEXT_ENABLED === '0' → 硬关，压过开关文件（EdgeOne 的环境变量构建时烘进去，改了要重新部署，只作兜底）。
//   2) 环境变量 FULLTEXT_ORIGIN 没配 → 当关（没有上游可打）。
//   3) 开关文件：COS 上的公开 JSON（默认 DEFAULT_SWITCH_URL，环境变量 FULLTEXT_SWITCH_URL 可覆盖），
//      内容 { "enabled": true|false, "reason": "...", "updatedAt": "<ISO>", "by": "<谁>" }；
//      由 .github/workflows/fulltext-switch.yml（fulltext/build/switch_cos.mjs）写，改完最多 SWITCH_TTL_SECONDS 秒＋浏览器 30 秒生效。
//      isolate 内存缓存 SWITCH_TTL_SECONDS 秒；读失败（网络错、非 200、不是合法 JSON、enabled 不是布尔）沿用上次读到的值，
//      失败后 SWITCH_RETRY_SECONDS 秒再试；本 isolate 从没读到过 → 当关（宁可隐藏，也别挂着坏的）。
//   关时：status 回 enabled:false（带 reason）；搜索回 503 { error: 'disabled' }、no-store，不打上游、不查缓存。
//
// 上游：GET ${FULLTEXT_ORIGIN}/api/fulltext?<校验后的白名单参数>，请求头 X-FT-Token: ${FULLTEXT_TOKEN}，超时 UPSTREAM_TIMEOUT_MS。
//   2xx JSON → 200 给浏览器并进缓存；上游 4xx／5xx 且带 JSON → 原样透传状态码与 JSON（400 bad_query、503 busy／warming／index_unavailable、504 timeout…），
//   no-store，Retry-After 一并透传。例外：上游 401／403／404 是令牌或地址配错（搜索机对令牌不符一律回 404），
//   对浏览器统一成 503 { error: 'upstream' }，只在函数日志里记一笔。
//   网络错 → 503 { error: 'upstream' }；超时 → 504 { error: 'timeout' }；上游 2xx 但不是 JSON → 503 { error: 'upstream' }。
//   任何响应都不带源站地址与令牌（报错只给代码）。
//
// 限流：按客户端 IP（只认 request.eo.clientIp，与 feedback.js 同理，不信 X-Forwarded-For），isolate 内存固定窗口，
//   每分钟 RATE_PER_MINUTE 次、每小时 RATE_PER_HOUR 次（只算搜索请求，status 不算）；超了 429 { error: 'rate_limited' } ＋ Retry-After。
//   取不到 IP 时不限（不让所有人挤一个名额）。isolate 多个、各算各的，只是粗闸。
//
// 缓存：索引最多每晚换一次，成功结果在 isolate 内存（LRU）与边缘 Cache API 各存 CACHE_SECONDS 秒；同一 isolate 同一查询并发只打一次上游。
//   浏览器 max-age=BROWSER_MAX_AGE_SECONDS。响应头 X-Fulltext-Cache：HIT／MISS。
// 观测：Server-Timing：parse、switch、cache、upstream、total。
//
// 配置（EdgeOne 项目环境变量，经 context.env 读）：
//   FULLTEXT_ORIGIN       上游 base，如 http://124.223.58.113:8765（不配＝关）
//   FULLTEXT_TOKEN        发给上游的 X-FT-Token（搜索机上配的同一把；不配就不带这个头）
//   FULLTEXT_ENABLED      '0' ＝ 硬关；其余值不起作用
//   FULLTEXT_SWITCH_URL   开关文件地址（不配用 DEFAULT_SWITCH_URL）

const DEFAULT_SWITCH_URL = 'https://book-index-data-1394555822.cos.ap-shanghai.myqcloud.com/fulltext/switch.json';

const MAX_Q_CODEPOINTS = 60; // 与 fulltext/service/app.py 的 MAX_Q 一致
const MAX_LIMIT = 50;
const MAX_OFFSET = 10000;
const MAX_PER_BOOK = 20;
const ENTRY_RE = /^[0-9A-Za-z]{1,32}$/;
const MODES = ['fuzzy', 'exact', 'near'];

const UPSTREAM_TIMEOUT_MS = 5000;
const SWITCH_TIMEOUT_MS = 2000;
const SWITCH_TTL_SECONDS = 30;
const SWITCH_RETRY_SECONDS = 10;
const STATUS_MAX_AGE_SECONDS = 30;
const REASON_MAX_CHARS = 200;

const RATE_PER_MINUTE = 30;
const RATE_PER_HOUR = 600;
const RATE_TABLE_MAX = 5000;

const CACHE_SECONDS = 600;
const BROWSER_MAX_AGE_SECONDS = 60;
const MEMORY_CACHE_MAX = 300;

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };
const NO_STORE = { 'Cache-Control': 'no-store' };

// 与 search.js / feedback.js 同样：先 context.env，再全局标识符
function readEnv(context, name) {
  if (context && context.env && context.env[name]) return String(context.env[name]);
  const g = globalThis[name];
  return g ? String(g) : '';
}

function getConfig(context) {
  const origin = readEnv(context, 'FULLTEXT_ORIGIN').trim().replace(/\/+$/, '');
  return {
    origin: /^https?:\/\/[^/\s]+$/i.test(origin) ? origin : '',
    token: readEnv(context, 'FULLTEXT_TOKEN').trim(),
    hardOff: readEnv(context, 'FULLTEXT_ENABLED').trim() === '0',
    switchUrl: readEnv(context, 'FULLTEXT_SWITCH_URL').trim() || DEFAULT_SWITCH_URL,
  };
}

function json(status, obj, extraHeaders = {}) {
  return new Response(typeof obj === 'string' ? obj : JSON.stringify(obj), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

function clock() {
  return (typeof performance !== 'undefined' && performance && typeof performance.now === 'function')
    ? performance.now() : Date.now();
}

function serverTiming() {
  const start = clock();
  const items = [];
  return {
    add(name, t0) { items.push({ name, dur: clock() - t0 }); },
    header() {
      return [...items, { name: 'total', dur: clock() - start }]
        .map((m) => `${m.name};dur=${Math.round(m.dur * 10) / 10}`).join(', ');
    },
  };
}

// ─── 开关 ───

/** isolate 内的开关状态：value 为 null 表示从没读到过 */
const switchState = { value: null, nextCheck: 0, url: '', inflight: null };

function parseSwitch(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.enabled !== 'boolean') return null;
  const reason = typeof raw.reason === 'string' ? raw.reason.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, REASON_MAX_CHARS) : '';
  return { enabled: raw.enabled, reason };
}

async function fetchSwitch(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SWITCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' } });
    if (!res.ok) return null;
    return parseSwitch(await res.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 开关文件当前值（带 isolate 缓存）；返回 null ＝ 从没读到过 */
async function readSwitch(url) {
  const now = Date.now();
  if (switchState.url !== url) {
    // 地址换了（测试里会换）：旧值作废
    switchState.url = url;
    switchState.value = null;
    switchState.nextCheck = 0;
    switchState.inflight = null;
  }
  if (now < switchState.nextCheck) return switchState.value;
  if (!switchState.inflight) {
    switchState.inflight = fetchSwitch(url).then((v) => {
      if (switchState.url === url) {
        if (v) switchState.value = v; // 读失败沿用上次的值
        switchState.nextCheck = Date.now() + (v ? SWITCH_TTL_SECONDS : SWITCH_RETRY_SECONDS) * 1000;
        switchState.inflight = null;
      }
      return v;
    });
  }
  await switchState.inflight;
  return switchState.value;
}

/** 综合判定：{ enabled, reason } */
async function currentSwitch(config) {
  if (config.hardOff) return { enabled: false, reason: 'disabled_by_env' };
  if (!config.origin) return { enabled: false, reason: 'not_configured' };
  const s = await readSwitch(config.switchUrl);
  if (!s) return { enabled: false, reason: 'switch_unavailable' };
  return s.enabled ? { enabled: true } : { enabled: false, reason: s.reason || 'disabled' };
}

// ─── 参数 ───

class BadQuery extends Error {}

function intParam(sp, name, def, lo, hi) {
  const raw = sp.get(name);
  if (raw === null || raw === '') return def;
  if (!/^-?\d+$/.test(raw)) throw new BadQuery(`${name} 必须是整数`);
  const v = Number(raw);
  if (!(v >= lo && v <= hi)) throw new BadQuery(`${name} 超出范围 [${lo}, ${hi}]`);
  return v;
}

/** 校验并规整成上游参数（固定顺序，兼作缓存键） */
function parseSearchParams(sp) {
  const rawQ = sp.get('q') || '';
  if (!rawQ.trim()) throw new BadQuery('q 不能为空');
  // 截到 61 个码点：上游 q[:60] 与 truncated 判定都不变（见文件头）
  const q = Array.from(rawQ).slice(0, MAX_Q_CODEPOINTS + 1).join('');
  const mode = sp.get('mode') || 'fuzzy';
  if (!MODES.includes(mode)) throw new BadQuery('mode 取值只能是 fuzzy、exact 或 near');
  const group = sp.get('group') || 'book';
  if (group !== 'book' && group !== 'none') throw new BadQuery('group 取值只能是 book 或 none');
  const entry = sp.get('entry') || '';
  if (entry && !ENTRY_RE.test(entry)) throw new BadQuery('entry 格式非法');
  const p = new URLSearchParams();
  p.set('q', q);
  p.set('mode', mode);
  p.set('group', group);
  p.set('limit', String(intParam(sp, 'limit', 10, 1, MAX_LIMIT)));
  p.set('offset', String(intParam(sp, 'offset', 0, 0, MAX_OFFSET)));
  p.set('per_book', String(intParam(sp, 'per_book', 3, 1, MAX_PER_BOOK)));
  if (entry) p.set('entry', entry);
  return p.toString();
}

// ─── 限流 ───

const rateTable = new Map(); // ip → { m, mc, h, hc }

/** 记一次；超限返回需要等待的秒数，否则 0 */
function rateCheck(ip, now = Date.now()) {
  const minute = Math.floor(now / 60000);
  const hour = Math.floor(now / 3600000);
  let r = rateTable.get(ip);
  if (!r) {
    if (rateTable.size >= RATE_TABLE_MAX) {
      for (const [k, v] of rateTable) if (v.h !== hour) rateTable.delete(k);
      while (rateTable.size >= RATE_TABLE_MAX) rateTable.delete(rateTable.keys().next().value);
    }
    r = { m: minute, mc: 0, h: hour, hc: 0 };
    rateTable.set(ip, r);
  }
  if (r.m !== minute) { r.m = minute; r.mc = 0; }
  if (r.h !== hour) { r.h = hour; r.hc = 0; }
  if (r.hc >= RATE_PER_HOUR) return Math.max(1, Math.ceil(((hour + 1) * 3600000 - now) / 1000));
  if (r.mc >= RATE_PER_MINUTE) return Math.max(1, Math.ceil(((minute + 1) * 60000 - now) / 1000));
  r.mc++;
  r.hc++;
  return 0;
}

function getClientIp(request) {
  const ip = request && request.eo && request.eo.clientIp;
  return typeof ip === 'string' && ip.trim() ? ip.trim() : null;
}

// ─── 缓存（isolate 内存 LRU ＋ 边缘 Cache API；条目 { t, body }） ───

const memoryCache = new Map();
const inflight = new Map();

function memoryGet(key, now) {
  const hit = memoryCache.get(key);
  if (!hit) return null;
  memoryCache.delete(key);
  if (now - hit.t >= CACHE_SECONDS * 1000) return null;
  memoryCache.set(key, hit); // LRU：挪到末尾
  return hit;
}

function memorySet(key, entry) {
  memoryCache.set(key, entry);
  while (memoryCache.size > MEMORY_CACHE_MAX) memoryCache.delete(memoryCache.keys().next().value);
}

function edgeCache() {
  try {
    return (typeof caches !== 'undefined' && caches && caches.default) ? caches.default : null;
  } catch {
    return null;
  }
}

function edgeCacheRequest(key) {
  return new Request(`https://fulltext-cache.invalid/v1?${key}`);
}

async function edgeGet(key, now) {
  const cache = edgeCache();
  if (!cache) return null;
  try {
    const res = await cache.match(edgeCacheRequest(key));
    if (!res) return null;
    const entry = JSON.parse(await res.text());
    if (!entry || typeof entry.t !== 'number' || typeof entry.body !== 'string') return null;
    return now - entry.t < CACHE_SECONDS * 1000 ? entry : null;
  } catch {
    return null;
  }
}

async function edgePut(key, entry) {
  const cache = edgeCache();
  if (!cache) return;
  try {
    await cache.put(edgeCacheRequest(key), new Response(JSON.stringify(entry), {
      headers: { ...JSON_HEADERS, 'Cache-Control': `public, max-age=${CACHE_SECONDS}` },
    }));
  } catch {
    // 缓存失败不影响结果
  }
}

async function deferOrAwait(context, promise) {
  if (context && typeof context.waitUntil === 'function') {
    context.waitUntil(promise);
    return;
  }
  await promise;
}

// ─── 上游 ───

/** 打上游，返回 { status, body(string), headers, cacheable } */
async function callUpstream(config, key) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${config.origin}/api/fulltext?${key}`, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json', ...(config.token ? { 'X-FT-Token': config.token } : {}) },
    });
  } catch {
    const timedOut = ctrl.signal.aborted;
    return { status: timedOut ? 504 : 503, body: JSON.stringify({ error: timedOut ? 'timeout' : 'upstream' }), cacheable: false };
  } finally {
    clearTimeout(timer);
  }
  let parsed;
  let text;
  try {
    text = await res.text();
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    console.error(`全文搜索上游回 ${res.status}：多半是 FULLTEXT_TOKEN 或 FULLTEXT_ORIGIN 配错`);
    return { status: 503, body: JSON.stringify({ error: 'upstream' }), cacheable: false };
  }
  if (res.ok) {
    if (!parsed || typeof parsed !== 'object') return { status: 503, body: JSON.stringify({ error: 'upstream' }), cacheable: false };
    return { status: 200, body: text, cacheable: true };
  }
  const retryAfter = res.headers && res.headers.get && res.headers.get('Retry-After');
  const headers = retryAfter && /^\d{1,5}$/.test(retryAfter) ? { 'Retry-After': retryAfter } : {};
  if (parsed && typeof parsed === 'object') return { status: res.status, body: JSON.stringify(parsed), headers, cacheable: false };
  return { status: res.status >= 500 ? res.status : 503, body: JSON.stringify({ error: 'upstream' }), headers, cacheable: false };
}

async function loadFromUpstream(context, config, key) {
  const r = await callUpstream(config, key);
  if (r.status === 200 && r.cacheable) {
    const entry = { t: Date.now(), body: r.body };
    memorySet(key, entry);
    await deferOrAwait(context, edgePut(key, entry));
  }
  return r;
}

function loadOnce(context, config, key) {
  let p = inflight.get(key);
  if (!p) {
    p = loadFromUpstream(context, config, key).finally(() => {
      if (inflight.get(key) === p) inflight.delete(key);
    });
    inflight.set(key, p);
  }
  return p;
}

// ─── 处理 ───

async function handleStatus(config) {
  const s = await currentSwitch(config);
  return json(200, s, { 'Cache-Control': `public, max-age=${STATUS_MAX_AGE_SECONDS}` });
}

async function handle(context) {
  const { request } = context;
  const url = new URL(request.url);
  const sp = url.searchParams;
  const config = getConfig(context);
  const op = sp.get('op');
  if (op === 'status') return handleStatus(config);
  if (op !== null) return json(400, { error: 'bad_query', message: 'op 只能是 status' }, NO_STORE);

  const timing = serverTiming();
  let t0 = clock();
  const s = await currentSwitch(config);
  timing.add('switch', t0);
  if (!s.enabled) return json(503, { error: 'disabled' }, { ...NO_STORE, 'Server-Timing': timing.header() });

  t0 = clock();
  let key;
  try {
    key = parseSearchParams(sp);
  } catch (e) {
    if (e instanceof BadQuery) return json(400, { error: 'bad_query', message: e.message }, NO_STORE);
    throw e;
  }
  timing.add('parse', t0);

  const ip = getClientIp(request);
  if (ip) {
    const wait = rateCheck(ip);
    if (wait) return json(429, { error: 'rate_limited' }, { ...NO_STORE, 'Retry-After': String(wait) });
  }

  t0 = clock();
  const now = Date.now();
  let entry = memoryGet(key, now);
  if (!entry) {
    entry = await edgeGet(key, now);
    if (entry) memorySet(key, entry);
  }
  timing.add('cache', t0);
  const okHeaders = (state) => ({
    'Cache-Control': `public, max-age=${BROWSER_MAX_AGE_SECONDS}`,
    'X-Fulltext-Cache': state,
    'Server-Timing': timing.header(),
  });
  if (entry) return json(200, entry.body, okHeaders('HIT'));

  t0 = clock();
  const r = await loadOnce(context, config, key);
  timing.add('upstream', t0);
  if (r.status === 200) return json(200, r.body, okHeaders('MISS'));
  return json(r.status, r.body, { ...NO_STORE, ...(r.headers || {}), 'Server-Timing': timing.header() });
}

// ─── 响应压缩（同 search.js，overview#487：EdgeOne 站点压缩对函数响应不生效，函数出口自己压 gzip） ───
const COMPRESS_MIN_BYTES = 1024;

async function gzipBytes(raw) {
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  writer.write(raw);
  writer.close();
  return new Response(cs.readable).arrayBuffer();
}

async function withCompression(res) {
  const vary = res.headers.get('Vary');
  if (!vary) res.headers.set('Vary', 'Accept-Encoding');
  else if (!/accept-encoding/i.test(vary)) res.headers.set('Vary', `${vary}, Accept-Encoding`);
  if (res.headers.has('Content-Encoding') || typeof CompressionStream === 'undefined') return res;
  try {
    const raw = new Uint8Array(await res.clone().arrayBuffer());
    if (raw.byteLength < COMPRESS_MIN_BYTES) return res;
    const gz = await gzipBytes(raw);
    const headers = new Headers(res.headers);
    headers.set('Content-Encoding', 'gzip');
    headers.set('Content-Length', String(gz.byteLength));
    return new Response(gz, { status: res.status, headers });
  } catch {
    return res;
  }
}

export async function onRequestGet(context) {
  return withCompression(await handle(context));
}
