// 书名搜索 HTTP 服务（上海搜索机，替代 Meili 的 7700）：边缘函数 → 本服务 → Postgres search_one。
//
//   POST /multi-search   { queries: [...] }  → { results: [...] }（与 Meili multi-search 同形，见 lib/query.mjs）
//   GET  /healthz        → { ok: true }；带正确的 Bearer 时多回 version（search_meta）与各类行数
//
// 环境变量：SEARCH_API_KEY（必填，边缘函数带 Authorization: Bearer）、PORT（默认 7710）、HOST（默认 0.0.0.0）、
//   PGHOST／PGPORT／PGDATABASE／PGUSER／PGPASSWORD（只读账号 search_ro）、
//   SEARCH_PG_SCHEMA（默认 search）、PG_POOL（默认 4）、PG_STATEMENT_TIMEOUT_MS（默认 2000）、MAX_QUEUE（默认 32）。
// 超时、排队满、库不通都回 503（边缘函数据此拿旧缓存或让前端退到简易搜索）。
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import pg from 'pg';
import { toCall, shapeResult, BadRequest, MAX_QUERIES, wantsFuzzy, fuzzyArgs, mergeFuzzy } from './lib/query.mjs';

const KEY = process.env.SEARCH_API_KEY || '';
if (!KEY) { console.error('需要设置 SEARCH_API_KEY'); process.exit(1); }
const SCHEMA = process.env.SEARCH_PG_SCHEMA || 'search';
if (!/^[a-z_][a-z0-9_]*$/.test(SCHEMA)) { console.error('SEARCH_PG_SCHEMA 不合法'); process.exit(1); }
const PORT = Number(process.env.PORT) || 7710;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_QUEUE = Number(process.env.MAX_QUEUE) || 32;
const MAX_BODY = 16 * 1024;

const pool = new pg.Pool({
    max: Number(process.env.PG_POOL) || 4,
    statement_timeout: Number(process.env.PG_STATEMENT_TIMEOUT_MS) || 2000,
    // search_path 只含本 schema 与 public：全量重建时 search_new 改名成 search，查询不用重连
    options: `-c search_path=${SCHEMA},public`,
});
pool.on('error', (e) => console.error('[pg pool]', e.message));

const FUZZY_ON = process.env.SEARCH_FUZZY !== '0';
const FUZZY_TIMEOUT_MS = Number(process.env.FUZZY_TIMEOUT_MS) || 600;
const FUZZY_SQL = 'SELECT search_fuzzy($1,$2,$3,$4::text[],$5::text[],$6::text[],$7::bool,$8::bool,$9::bool,$10::text) AS r';

/** 模糊补充：独立事务、更短的超时；任何失败（含函数还没建）都只当没有，不影响精确结果 */
async function runFuzzy(call) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(`SET LOCAL statement_timeout = ${FUZZY_TIMEOUT_MS}`);
        const { rows } = await client.query(FUZZY_SQL, fuzzyArgs(call));
        await client.query('COMMIT');
        return rows[0].r;
    } catch (e) {
        try { await client.query('ROLLBACK'); } catch { /* 连接坏了由池回收 */ }
        console.error('[fuzzy]', e && e.message);
        return null;
    } finally {
        client.release();
    }
}

let waiting = 0;
const SQL = 'SELECT search_one($1,$2,$3,$4,$5::text[],$6::text[],$7::text[],$8::bool,$9::bool,$10::bool,$11::text,$12::text) AS r';

async function runCall(call) {
    if (call.empty || !call.q) return shapeResult(call, { hits: [], estimatedTotalHits: 0 }, 0);
    if (waiting >= MAX_QUEUE) throw Object.assign(new Error('queue full'), { status: 503 });
    waiting++;
    const t0 = performance.now();
    try {
        const { rows } = await pool.query(SQL, call.args);
        let row = rows[0].r;
        if (FUZZY_ON && wantsFuzzy(call, row)) row = mergeFuzzy(call, row, await runFuzzy(call));
        return shapeResult(call, row, Math.round(performance.now() - t0));
    } finally {
        waiting--;
    }
}

function authed(req) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
    if (!m) return false;
    const a = Buffer.from(m[1]); const b = Buffer.from(KEY);
    return a.length === b.length && timingSafeEqual(a, b);
}

function send(res, status, obj, headers = {}) {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(body);
}

async function readBody(req) {
    let n = 0; const chunks = [];
    for await (const c of req) { n += c.length; if (n > MAX_BODY) throw new BadRequest('请求体过大'); chunks.push(c); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new BadRequest('请求体须为 JSON'); }
}

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, 'http://x');
        if (req.method === 'GET' && url.pathname === '/healthz') {
            if (!authed(req)) return send(res, 200, { ok: true });
            const { rows } = await pool.query(`SELECT k, v FROM ${SCHEMA}.search_meta`);
            return send(res, 200, { ok: true, meta: Object.fromEntries(rows.map((r) => [r.k, r.v])) });
        }
        if (req.method === 'POST' && url.pathname === '/multi-search') {
            if (!authed(req)) return send(res, 401, { error: 'unauthorized' });
            const body = await readBody(req);
            const queries = body && body.queries;
            if (!Array.isArray(queries) || queries.length < 1 || queries.length > MAX_QUERIES) throw new BadRequest(`queries 须为 1–${MAX_QUERIES} 条`);
            const calls = queries.map(toCall);
            const results = await Promise.all(calls.map(runCall));
            return send(res, 200, { results });
        }
        send(res, 404, { error: 'not_found' });
    } catch (e) {
        if (e instanceof BadRequest) return send(res, 400, { error: e.message });
        const timedOut = e && e.code === '57014'; // statement_timeout
        console.error('[search-api]', e && e.message);
        send(res, timedOut ? 504 : 503, { error: timedOut ? 'timeout' : 'unavailable' }, { 'Retry-After': '5' });
    }
});
server.keepAliveTimeout = 30_000;
server.listen(PORT, HOST, () => console.log(`search-api on ${HOST}:${PORT}, schema=${SCHEMA}`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => pool.end().then(() => process.exit(0))));
