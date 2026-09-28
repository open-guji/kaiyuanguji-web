/**
 * dq-lib.mjs — 正式数据巡检（DQ 道）的纯函数与编排逻辑
 *
 * 只读巡检 data.kaiyuanguji.com 上的 current/ 与 h1/：
 *   latest.json ─┬─ current/{version,meta,promotions}.json（?v=<cacheKey，缺则 commitId> cache-bust，与前端同法）
 *                └─ h1/manifest-root.json → roots/<key>.json → 1,296 个 manifest 分片 → entry/<id>.<hash8>.json
 *                   h1/text-manifest-root.json → text-roots/<key>.json → text-manifest 分片 → text/<owner>/…
 *
 * 布局约定照抄 nextjs/scripts/bundle-hashed*.mjs 与 nextjs/src/lib/cos-storage.ts；
 * id 的类型位解码照抄 book-index-ui 的 extractType（这里解不出时记 unknown，不像 UI 那样兜底成 book）。
 *
 * 发现的问题分两类（见 FINDING_KINDS）：
 *   packaging  网站打包／分发问题：指针、分片、哈希、current 与 h1 不一致、登记了却取不到……
 *              ——修在本仓的 bundle／sync 流程里
 *   data       数据仓问题：条目内容本身不合规、引用悬空、全文索引登记了不存在的卷章……
 *              ——修在 book-index-draft／book-index／book-text
 *
 * 抓取要客气：并发硬上限 8；每个请求最多 5 次尝试；429／5xx／网络错都退避，
 * 429 会让所有 worker 一起暂停（共享冷却），尊重 Retry-After。
 *
 * CLI 入口是 ops/dq-check.mjs；本文件不读 process.env／argv，便于单测注入假 fetch。
 */

import { createHash } from 'node:crypto';

export const DEFAULT_BASE = 'https://data.kaiyuanguji.com';
export const MAX_CONCURRENCY = 8;
export const VALID_TYPES = ['work', 'book', 'collection', 'entity'];
export const REF_FIELDS = ['work_id', 'books', 'related_works', 'contained_in'];
export const FINDING_KINDS = {
    packaging: '网站打包问题',
    data: '数据仓问题',
    fetch: '巡检取数失败（重试用尽的网络错误，不算数据问题）',
    info: '提示（不算问题）',
};

/** 取不到的资源：真有 HTTP 状态（404/403…）算打包问题；status 0（网络错误重试用尽）单列。 */
const missKind = (r) => (r.status === 0 ? 'fetch' : 'packaging');

/** 网络错误占全部请求超过这个比例时，巡检本身不可信，job 也该变红。 */
export const FETCH_FAIL_RATIO = 0.01;

// ─── id 解码（book-index-ui extractType 的同一套位布局） ───
//
// 64 位：bit62 status（0 official / 1 draft）、bit59-61 type（0 book / 2 collection /
// 3 work / 4 entity）。字符串是 base36（小写）；含大写字母时是 base58（旧 id）。

const B36 = '0123456789abcdefghijklmnopqrstuvwxyz';
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const TYPE_BITS = { 0: 'book', 2: 'collection', 3: 'work', 4: 'entity' };
const STATUS_BITS = { 0: 'official', 1: 'draft' };

function parseBase(str, alphabet) {
    const radix = BigInt(alphabet.length);
    let n = 0n;
    for (const ch of str) {
        const v = alphabet.indexOf(ch);
        if (v < 0) return null;
        n = n * radix + BigInt(v);
    }
    return n;
}

/** → { type, status }；解不出返回 { type: 'unknown', status: 'unknown' }。 */
export function decodeId(id) {
    if (typeof id !== 'string' || id.length === 0) return { type: 'unknown', status: 'unknown' };
    const n = /[A-Z]/.test(id) ? parseBase(id, B58) : parseBase(id, B36);
    if (n === null) return { type: 'unknown', status: 'unknown' };
    return {
        type: TYPE_BITS[Number((n >> 59n) & 7n)] ?? 'unknown',
        status: STATUS_BITS[Number((n >> 62n) & 1n)] ?? 'unknown',
    };
}

// ─── h1 路径约定 ───

export function shardKeyFor(id, len = 2) {
    return id.slice(-len);
}

/** relPath 最后一段插入哈希：与 bundle-hashed-text.mjs／cos-storage.ts 的 insertHash 同一算法。 */
export function insertHash(relPath, hash) {
    const slash = relPath.lastIndexOf('/');
    const dir = slash === -1 ? '' : relPath.slice(0, slash + 1);
    const base = slash === -1 ? relPath : relPath.slice(slash + 1);
    const dot = base.lastIndexOf('.');
    if (dot === -1) return `${dir}${base}.${hash}`;
    return `${dir}${base.slice(0, dot)}.${hash}${base.slice(dot)}`;
}

export function hash8(buf) {
    return createHash('sha256').update(buf).digest('hex').slice(0, 8);
}

// ─── 抽样：带种子，可复现 ───

export function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** 从 items 里按 rate 抽 ceil(len*rate) 个（至少 1 个，items 非空时），同 seed 同结果；返回按原序。 */
export function sample(items, rate, seed) {
    const sorted = [...items].sort();
    if (sorted.length === 0 || rate <= 0) return [];
    const k = Math.min(sorted.length, Math.max(1, Math.ceil(sorted.length * rate)));
    if (k === sorted.length) return sorted;
    const rand = mulberry32(seed);
    // 部分 Fisher–Yates：只洗前 k 个
    const arr = sorted.slice();
    for (let i = 0; i < k; i++) {
        const j = i + Math.floor(rand() * (arr.length - i));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr.slice(0, k).sort();
}

// ─── 引用抽取 ───

function refId(v) {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') {
        if (typeof v.id === 'string') return v.id;
        if (typeof v.work_id === 'string') return v.work_id;
    }
    return null;
}

/** → [{ field, id }]；形状不认识的值记成 { field, bad: <原值> }。 */
export function extractRefs(entry, fields = REF_FIELDS) {
    const out = [];
    for (const field of fields) {
        const v = entry[field];
        if (v === undefined || v === null || v === '') continue;
        const list = Array.isArray(v) ? v : [v];
        for (const item of list) {
            const id = refId(item);
            if (id) out.push({ field, id });
            else out.push({ field, bad: item });
        }
    }
    return out;
}

// ─── 全文／整理本：index.json 登记了哪些文件 ───

/**
 * 给一个 owner 的 text-manifest 条目（relPath → hash8），列出所有 index.json
 * 及它们登记的文件（relPath，已按 bundle-data.mjs 的规则把 .md 改 .txt）。
 * 调用方负责取 index.json 内容，这里只接受已解析的对象：
 *   indexes: [{ path, doc }]
 * → [{ index, registered: [relPath...], format }]
 */
export function registeredTextFiles(indexPath, doc) {
    const dir = indexPath.slice(0, indexPath.lastIndexOf('/') + 1);
    const out = [];
    if (indexPath.startsWith('collated_edition/')) {
        if (Array.isArray(doc?.juan_files)) {
            for (const f of doc.juan_files) if (typeof f === 'string') out.push(`${dir}${f}`);
            return { format: 'collated.juan_files', registered: out };
        }
        return { format: 'collated.unknown', registered: out };
    }
    if (indexPath.startsWith('full_text/')) {
        if (Array.isArray(doc?.chapters)) {
            for (const c of doc.chapters) {
                const f = typeof c === 'string' ? c : c?.file;
                if (typeof f !== 'string') continue;
                out.push(`${dir}${f.endsWith('.md') ? f.slice(0, -3) + '.txt' : f}`);
            }
            return { format: 'full_text.chapters', registered: out };
        }
        return { format: 'full_text.unknown', registered: out };
    }
    return { format: 'unknown', registered: out };
}

export function isTextIndexPath(p) {
    return p === 'collated_edition/index.json'
        || p === 'collated_edition/collated_edition_index.json'
        || p === 'full_text/index.json'
        || /^full_text\/[^/]+\/index\.json$/.test(p);
}

// ─── 客气的 HTTP ───

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createHttp({ fetchImpl = fetch, maxAttempts = 5, baseDelayMs = 1000, timeoutMs = 30_000, sleepImpl = sleep } = {}) {
    let cooldownUntil = 0;
    const stats = { requests: 0, retries: 0, throttled: 0, failures: 0 };

    async function waitCooldown() {
        const wait = cooldownUntil - Date.now();
        if (wait > 0) await sleepImpl(wait);
    }

    /**
     * → { status, ok, body: Buffer|null, error? }。404 等 4xx（429 除外）不重试，直接返回。
     * 网络错误／5xx／429 重试到 maxAttempts，仍失败返回 { status: 0 或最后状态, ok: false, error }。
     */
    async function request(url, { method = 'GET' } = {}) {
        let last = { status: 0, ok: false, body: null, error: 'no attempt' };
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            await waitCooldown();
            stats.requests++;
            let res;
            try {
                res = await fetchImpl(url, { method, signal: AbortSignal.timeout(timeoutMs) });
            } catch (e) {
                last = { status: 0, ok: false, body: null, error: String(e?.message ?? e) };
                if (attempt < maxAttempts) {
                    stats.retries++;
                    await sleepImpl(backoff(attempt));
                }
                continue;
            }
            if (res.status === 429 || res.status >= 500) {
                last = { status: res.status, ok: false, body: null, error: `HTTP ${res.status}` };
                if (res.status === 429) {
                    stats.throttled++;
                    const ra = Number(res.headers?.get?.('retry-after'));
                    const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoff(attempt) * 2;
                    cooldownUntil = Math.max(cooldownUntil, Date.now() + wait);
                }
                try { await res.arrayBuffer?.(); } catch { /* 丢弃 body */ }
                if (attempt < maxAttempts) {
                    stats.retries++;
                    if (res.status !== 429) await sleepImpl(backoff(attempt));
                }
                continue;
            }
            const body = method === 'HEAD' ? null : Buffer.from(await res.arrayBuffer());
            return { status: res.status, ok: res.ok, body };
        }
        stats.failures++;
        return last;
    }

    function backoff(attempt) {
        return baseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * baseDelayMs);
    }

    async function getJson(url) {
        const r = await request(url);
        if (!r.ok) return { ...r, json: null };
        try {
            return { ...r, json: JSON.parse(r.body.toString('utf-8')) };
        } catch (e) {
            return { ...r, json: null, parseError: e.message };
        }
    }

    return { request, getJson, stats };
}

/** 并发池：同时最多 n 个在飞（n 被夹到 [1, MAX_CONCURRENCY]）。结果按输入顺序返回。 */
export async function pool(items, n, fn) {
    const limit = Math.max(1, Math.min(MAX_CONCURRENCY, n | 0));
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
        while (next < items.length) {
            const i = next++;
            results[i] = await fn(items[i], i);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

// ─── 巡检编排 ───

/** current 版（Buffer）与 h1 版（已解析对象）有哪些顶层字段不同；current 不是 JSON 返回 null。 */
function diffKeys(currentBuf, h1Entry) {
    let ce;
    try { ce = JSON.parse(currentBuf.toString('utf-8')); } catch { return null; }
    const keys = new Set([...Object.keys(ce), ...Object.keys(h1Entry)]);
    return [...keys].filter((k) => JSON.stringify(ce[k]) !== JSON.stringify(h1Entry[k]));
}

function fmtCommit(dc) {
    return dc ? `${(dc.commitId ?? '').slice(0, 12)}/${(dc.productionCommitId ?? '').slice(0, 12)}/${(dc.textCommitId ?? '').slice(0, 12)}` : '(无)';
}

function sameDataCommit(latest, dc) {
    if (!dc) return false;
    return (dc.commitId ?? '') === (latest.fullCommitId ?? latest.commitId ?? '')
        && (dc.productionCommitId ?? '') === (latest.productionCommitId ?? '')
        && (dc.textCommitId ?? '') === (latest.textCommitId ?? '');
}

/**
 * 跑一次巡检。opts：
 *   base            站点根（默认 DEFAULT_BASE）
 *   h1Prefix        h1 子路径（默认 'h1'；测试站是 'staging/h1'）
 *   entryRate       条目抽样率（默认 0.02）
 *   textRate        全文 owner 抽样率（默认 0.05）
 *   seed            抽样种子
 *   concurrency     并发（≤ 8）
 *   pointerRetryMs  指针与 latest.json 对不上时（部署进行中）最多等多久，每 60s 看一次；0 不等
 *   fetchImpl, sleepImpl, log
 * → report 对象（见 renderMarkdown）
 */
export async function runDq(opts = {}) {
    const base = (opts.base ?? DEFAULT_BASE).replace(/\/$/, '');
    const h1 = `${base}/${(opts.h1Prefix ?? 'h1').replace(/^\/|\/$/g, '')}`;
    const entryRate = opts.entryRate ?? 0.02;
    const textRate = opts.textRate ?? 0.05;
    const seed = opts.seed ?? 1;
    const concurrency = Math.min(MAX_CONCURRENCY, opts.concurrency ?? MAX_CONCURRENCY);
    const pointerRetryMs = opts.pointerRetryMs ?? 600_000;
    const log = opts.log ?? (() => {});
    const sleepImpl = opts.sleepImpl ?? sleep;
    const http = createHttp({ fetchImpl: opts.fetchImpl, sleepImpl, baseDelayMs: opts.baseDelayMs });
    const t0 = Date.now();
    const phases = {};

    const findings = [];
    const add = (kind, code, message, detail) => findings.push({ kind, code, message, ...(detail ? { detail } : {}) });

    const report = {
        base, h1, seed, entryRate, textRate, concurrency,
        startedAt: new Date(t0).toISOString(),
        latest: null, pointers: {}, counts: {}, entries: {}, refs: {}, text: {}, findings, phases, http: http.stats,
    };

    // ── 0. 指针 ──
    let tp = Date.now();
    const latestRes = await http.getJson(`${base}/latest.json?dq=${t0}`);
    if (!latestRes.json?.commitId) {
        add('packaging', 'latest-unreadable', `latest.json 取不到或缺 commitId（HTTP ${latestRes.status}）`);
        report.finishedAt = new Date().toISOString();
        report.durationMs = Date.now() - t0;
        return report;
    }
    const latest = latestRes.json;
    report.latest = latest;
    // 与前端同口径（nextjs/src/lib/data-version.ts）：优先三仓合成键，旧数据回退 commitId
    const v = latest.cacheKey || latest.commitId;
    const cur = (p) => `${base}/current/${p}?v=${v}`;

    const [versionRes, metaRes, promoRes] = await Promise.all([
        http.getJson(cur('version.json')), http.getJson(cur('meta.json')), http.getJson(cur('promotions.json')),
    ]);
    if (!versionRes.json) add('packaging', 'current-version-unreadable', `current/version.json 取不到（HTTP ${versionRes.status}）`);
    else if (!sameDataCommit(latest, versionRes.json)) {
        const fresh = await http.getJson(`${base}/current/version.json?v=dq-${t0}`);
        const cdnStale = fresh.json && sameDataCommit(latest, fresh.json);
        add('packaging', cdnStale ? 'current-version-cdn-stale' : 'current-version-mismatch',
            cdnStale ? `current/version.json?v=${v} 命中 CDN 旧缓存，源站已是新版` : 'current/version.json 与 latest.json 指的不是同一版数据（绕过 CDN 后仍不一致）',
            { latest: fmtCommit({ commitId: latest.fullCommitId, productionCommitId: latest.productionCommitId, textCommitId: latest.textCommitId }), current: fmtCommit(versionRes.json) });
    }
    const meta = metaRes.json;
    if (!meta) add('packaging', 'meta-unreadable', `current/meta.json 取不到（HTTP ${metaRes.status}）`);
    const promotions = new Map(Object.entries(promoRes.json?.promotions ?? {}));
    if (!promoRes.json) add('packaging', 'promotions-unreadable', `current/promotions.json 取不到（HTTP ${promoRes.status}）`);

    async function loadPointer(name, rootsDir) {
        const ptr = await http.getJson(`${h1}/${name}?dq=${Date.now()}`);
        if (!ptr.json?.root) return { ptr: null, status: ptr.status };
        const rootDoc = await http.getJson(`${h1}/${rootsDir}/${ptr.json.root}`);
        return { ptr: ptr.json, root: rootDoc.json, rootStatus: rootDoc.status };
    }
    let entryP = await loadPointer('manifest-root.json', 'roots');
    let textP = await loadPointer('text-manifest-root.json', 'text-roots');
    const lagging = () => [entryP, textP].some((p) => p.ptr && !sameDataCommit(latest, p.ptr.dataCommit));
    // 部署时 latest.json、entry 指针、text 指针先后翻转，相隔几分钟（实测 text 比 entry 晚约 4.5 分钟）
    for (let waited = 0; lagging() && waited < pointerRetryMs; ) {
        const step = Math.min(60_000, pointerRetryMs - waited);
        log(`指针与 latest.json 对不上，可能正在部署，${Math.round(step / 1000)}s 后再看（已等 ${Math.round(waited / 1000)}s）`);
        await sleepImpl(step);
        waited += step;
        entryP = await loadPointer('manifest-root.json', 'roots');
        textP = await loadPointer('text-manifest-root.json', 'text-roots');
    }
    report.pointerWaitNeeded = lagging() ? 'timeout' : undefined;
    for (const [label, p] of [['h1/manifest-root.json', entryP], ['h1/text-manifest-root.json', textP]]) {
        report.pointers[label] = p.ptr ? { root: p.ptr.root, generatedAt: p.ptr.generatedAt, dataCommit: fmtCommit(p.ptr.dataCommit) } : null;
        if (!p.ptr) { add('packaging', 'pointer-unreadable', `${label} 取不到或缺 root（HTTP ${p.status}）`); continue; }
        if (!p.root) { add('packaging', 'root-unreadable', `${label} 指向的 ${p.ptr.root} 取不到（HTTP ${p.rootStatus}）`); continue; }
        if (!sameDataCommit(latest, p.ptr.dataCommit)) {
            add('packaging', 'pointer-lag', `${label} 与 latest.json 不是同一版数据（等待部署后仍不一致）`,
                { latest: fmtCommit({ commitId: latest.fullCommitId, productionCommitId: latest.productionCommitId, textCommitId: latest.textCommitId }), pointer: fmtCommit(p.ptr.dataCommit) });
        }
        if (p.root && JSON.stringify(p.root.dataCommit) !== JSON.stringify(p.ptr.dataCommit)) {
            add('packaging', 'root-pointer-mismatch', `${label} 的 dataCommit 与它指向的 root 文档不一致`);
        }
    }
    phases.pointers = Date.now() - tp;

    // ── 1. manifest 全量：root → 分片 → id ──
    tp = Date.now();
    const manifest = new Map(); // id → hash8
    const entryRoot = entryP.root;
    if (entryRoot?.shards) {
        const keyLen = entryRoot.shardKeyLength ?? 2;
        const shardEntries = Object.entries(entryRoot.shards);
        if (entryRoot.shardCount !== undefined && entryRoot.shardCount !== shardEntries.length) {
            add('packaging', 'shard-count-mismatch', `root 声明 shardCount=${entryRoot.shardCount}，实际列出 ${shardEntries.length} 个分片`);
        }
        let shardsBad = 0;
        await pool(shardEntries, concurrency, async ([key, h]) => {
            const r = await http.getJson(`${h1}/manifest/${key}.${h}.json`);
            if (!r.json) {
                shardsBad++;
                add(missKind(r), 'shard-unreadable', `manifest/${key}.${h}.json 取不到或不是 JSON（HTTP ${r.status}）`);
                return;
            }
            if (hash8(r.body) !== h) add('packaging', 'shard-hash-mismatch', `manifest/${key}.${h}.json 内容哈希对不上文件名（实际 ${hash8(r.body)}）`);
            for (const [id, eh] of Object.entries(r.json)) {
                if (shardKeyFor(id, keyLen) !== key) add('packaging', 'shard-misplaced-id', `${id} 出现在分片 ${key}，后缀对不上`);
                if (!/^[0-9a-f]{8}$/.test(eh)) add('packaging', 'bad-entry-hash', `${id} 的哈希 ${JSON.stringify(eh)} 不是 8 位十六进制`);
                if (manifest.has(id)) add('packaging', 'duplicate-id', `${id} 在多个分片里出现`);
                manifest.set(id, eh);
            }
        });
        report.counts.shards = shardEntries.length;
        report.counts.shardsUnreadable = shardsBad;
    }
    report.counts.total = manifest.size;
    const byType = {}, byStatus = {};
    for (const id of manifest.keys()) {
        const d = decodeId(id);
        byType[d.type] = (byType[d.type] ?? 0) + 1;
        byStatus[d.status] = (byStatus[d.status] ?? 0) + 1;
    }
    report.counts.byType = byType;
    report.counts.byStatus = byStatus;
    if (byType.unknown) add('data', 'id-type-undecodable', `${byType.unknown} 个 id 解不出类型位`);
    if (meta) {
        const metaByType = { work: meta.works, book: meta.books, collection: meta.collections, entity: meta.entities };
        report.counts.meta = metaByType;
        const diffs = Object.entries(metaByType).filter(([t, n]) => (byType[t] ?? 0) !== n)
            .map(([t, n]) => `${t}: manifest ${byType[t] ?? 0} / meta ${n}`);
        if (diffs.length) add('packaging', 'meta-count-mismatch', 'h1 manifest 各类型条目数与 current/meta.json 对不上', { diffs });
    }
    phases.manifest = Date.now() - tp;
    log(`manifest：${manifest.size} 条，${report.counts.shards ?? 0} 个分片`);

    // ── 2. 条目抽样：h1 可解析、id／type 合法、与 current 一致 ──
    tp = Date.now();
    const sampledIds = sample([...manifest.keys()], entryRate, seed);
    const E = { sampled: sampledIds.length, h1Bad: 0, hashMismatch: 0, idMismatch: 0, typeInvalid: 0, typeBitMismatch: 0, currentMissing: 0, currentDiffer: 0, currentCdnStale: 0, currentMatch: 0 };
    report.entries = E;
    const sampledEntries = new Map();
    await pool(sampledIds, concurrency, async (id) => {
        const h = manifest.get(id);
        const r = await http.request(`${h1}/entry/${encodeURIComponent(id)}.${h}.json`);
        if (!r.ok) { E.h1Bad++; add(missKind(r), 'h1-entry-missing', `h1/entry/${id}.${h}.json 取不到（HTTP ${r.status}）`); return; }
        if (hash8(r.body) !== h) { E.hashMismatch++; add('packaging', 'h1-entry-hash-mismatch', `h1/entry/${id}.${h}.json 内容哈希实际是 ${hash8(r.body)}`); }
        let e;
        try { e = JSON.parse(r.body.toString('utf-8')); } catch (err) {
            E.h1Bad++; add('data', 'entry-not-json', `${id} 不是合法 JSON：${err.message}`); return;
        }
        sampledEntries.set(id, e);
        if (e.id !== id) { E.idMismatch++; add('data', 'entry-id-mismatch', `${id} 文件里的 id 是 ${JSON.stringify(e.id)}`, { path: e._path }); }
        if (!VALID_TYPES.includes(e.type)) { E.typeInvalid++; add('data', 'entry-type-invalid', `${id} 的 type=${JSON.stringify(e.type)} 不合法`, { path: e._path }); }
        else {
            const bits = decodeId(id).type;
            if (bits !== 'unknown' && bits !== e.type) { E.typeBitMismatch++; add('data', 'entry-type-bits-mismatch', `${id} 的 type=${e.type}，id 类型位是 ${bits}`, { path: e._path }); }
        }

        const c = await http.request(cur(`entry/${encodeURIComponent(id)}.json`));
        if (!c.ok) { E.currentMissing++; add(missKind(c), 'current-entry-missing', `current/entry/${id}.json 取不到（HTTP ${c.status}），h1 有`); return; }
        if (c.body.equals(r.body)) { E.currentMatch++; return; }
        E.currentDiffer++;
        // 分清是 CDN 按 ?v=<commitId> 缓存了旧版（源站其实已一致），还是源站本身就不一致：
        // 换一个没人用过的 v 绕过节点缓存再取一次。
        const fresh = await http.request(`${base}/current/entry/${encodeURIComponent(id)}.json?v=dq-${t0}`);
        if (fresh.ok && fresh.body.equals(r.body)) {
            E.currentCdnStale++;
            add('packaging', 'current-cdn-stale', `${id}：current/entry?v=${v} 命中 CDN 旧缓存，源站已与 h1 一致`,
                { changed: diffKeys(c.body, e) });
            return;
        }
        const changed = diffKeys(c.body, e);
        const explain = changed === null ? 'current 版不是合法 JSON'
            : changed.length ? `字段不同：${changed.join(', ')}` : '仅格式／字段顺序不同，内容等价';
        add('packaging', 'current-h1-differ', `${id}：current 与 h1 不一致，绕过 CDN 缓存后仍不一致（${explain}）`);
    });
    phases.entries = Date.now() - tp;
    log(`条目：抽 ${E.sampled}，current 一致 ${E.currentMatch}`);

    // ── 3. 引用完整性 ──
    tp = Date.now();
    const R = { refs: 0, unique: 0, resolvedViaPromotion: 0, dangling: 0, unreachable: 0, badShape: 0, byField: {} };
    report.refs = R;
    const toFetch = new Map(); // id → [{from, field}]
    const dangling = [];
    for (const [from, e] of sampledEntries) {
        for (const ref of extractRefs(e)) {
            R.refs++;
            const f = (R.byField[ref.field] ??= { refs: 0, dangling: 0 });
            f.refs++;
            if (ref.bad !== undefined) {
                R.badShape++;
                add('data', 'ref-bad-shape', `${from}.${ref.field} 有一项形状不认识：${JSON.stringify(ref.bad).slice(0, 120)}`, { path: e._path });
                continue;
            }
            let target = ref.id;
            if (!manifest.has(target) && promotions.has(target)) { R.resolvedViaPromotion++; target = promotions.get(target); }
            if (!manifest.has(target)) {
                R.dangling++; f.dangling++;
                dangling.push({ from, field: ref.field, to: ref.id, path: e._path });
                continue;
            }
            if (!toFetch.has(target)) toFetch.set(target, []);
            toFetch.get(target).push({ from, field: ref.field });
        }
    }
    R.unique = toFetch.size;
    for (const d of dangling) add('data', 'ref-dangling', `${d.from}.${d.field} → ${d.to} 悬空（manifest 与升格表里都没有）`, { path: d.path });
    await pool([...toFetch.keys()], concurrency, async (id) => {
        const r = await http.request(`${h1}/entry/${encodeURIComponent(id)}.${manifest.get(id)}.json`, { method: 'HEAD' });
        if (!r.ok) {
            R.unreachable++;
            add(missKind(r), 'ref-unreachable', `被引用的 ${id} 在 manifest 里，但 h1 entry 取不到（HTTP ${r.status}）`, { referencedBy: toFetch.get(id).slice(0, 3) });
        }
    });
    phases.refs = Date.now() - tp;
    log(`引用：${R.refs} 处，悬空 ${R.dangling}`);

    // ── 4. 全文与整理本 ──
    tp = Date.now();
    const T = { shards: 0, owners: 0, files: 0, ownersSampled: 0, indexes: 0, indexBad: 0, registered: 0, registeredMissing: 0, filesChecked: 0, filesUnreachable: 0, ownersNotInManifest: 0, unregisteredFiles: 0, formats: {} };
    report.text = T;
    const textRoot = textP.root;
    if (textRoot?.shards) {
        const keyLen = textRoot.shardKeyLength ?? 2;
        const tshards = Object.entries(textRoot.shards);
        T.shards = tshards.length;
        if (textRoot.shardCount !== undefined && textRoot.shardCount !== tshards.length) {
            add('packaging', 'text-shard-count-mismatch', `text root 声明 shardCount=${textRoot.shardCount}，实际列出 ${tshards.length}`);
        }
        const owners = new Map(); // owner → { relPath → hash }
        await pool(tshards, concurrency, async ([key, h]) => {
            const r = await http.getJson(`${h1}/text-manifest/${key}.${h}.json`);
            if (!r.json) { add(missKind(r), 'text-shard-unreadable', `text-manifest/${key}.${h}.json 取不到（HTTP ${r.status}）`); return; }
            if (hash8(r.body) !== h) add('packaging', 'text-shard-hash-mismatch', `text-manifest/${key}.${h}.json 内容哈希对不上`);
            for (const [owner, files] of Object.entries(r.json)) {
                if (shardKeyFor(owner, keyLen) !== key) add('packaging', 'text-shard-misplaced', `owner ${owner} 出现在分片 ${key}`);
                owners.set(owner, files);
            }
        });
        T.owners = owners.size;
        T.files = [...owners.values()].reduce((n, f) => n + Object.keys(f).length, 0);
        if (textRoot.ownerCount !== undefined && textRoot.ownerCount !== T.owners) add('packaging', 'text-owner-count-mismatch', `text root 声明 ownerCount=${textRoot.ownerCount}，分片合计 ${T.owners}`);
        if (textRoot.fileCount !== undefined && textRoot.fileCount !== T.files) add('packaging', 'text-file-count-mismatch', `text root 声明 fileCount=${textRoot.fileCount}，分片合计 ${T.files}`);

        const orphanOwners = [...owners.keys()].filter((o) => manifest.size > 0 && !manifest.has(o) && !(promotions.has(o) && manifest.has(promotions.get(o))));
        T.ownersNotInManifest = orphanOwners.length;
        if (orphanOwners.length) add('data', 'text-owner-orphan', `${orphanOwners.length} 个全文／整理本 owner 在条目 manifest 里找不到`, { examples: orphanOwners.slice(0, 20) });

        const sampledOwners = sample([...owners.keys()], textRate, seed ^ 0x5eed);
        T.ownersSampled = sampledOwners.length;
        const fileChecks = [];
        await pool(sampledOwners, concurrency, async (owner) => {
            const files = owners.get(owner);
            const registeredAll = new Set();
            const indexPaths = Object.keys(files).filter(isTextIndexPath);
            if (indexPaths.length === 0) add('data', 'text-no-index', `${owner} 有 ${Object.keys(files).length} 个文本文件，但没有任何 index.json`);
            for (const ip of indexPaths) {
                T.indexes++;
                const url = `${h1}/text/${encodeURIComponent(owner)}/${insertHash(ip, files[ip])}`;
                const r = await http.request(url);
                if (!r.ok) { T.indexBad++; add(missKind(r), 'text-index-missing', `${owner}/${ip} 登记在 manifest，取不到（HTTP ${r.status}）`); continue; }
                if (hash8(r.body) !== files[ip]) add('packaging', 'text-index-hash-mismatch', `${owner}/${ip} 内容哈希对不上`);
                let doc;
                try { doc = JSON.parse(r.body.toString('utf-8')); } catch (e) {
                    T.indexBad++; add('data', 'text-index-not-json', `${owner}/${ip} 不是合法 JSON：${e.message}`); continue;
                }
                const { format, registered } = registeredTextFiles(ip, doc);
                T.formats[format] = (T.formats[format] ?? 0) + 1;
                if (format.endsWith('unknown')) add('info', 'text-index-format-unknown', `${owner}/${ip} 的格式巡检不认识，未核对登记文件`, { keys: Object.keys(doc ?? {}).slice(0, 12) });
                const missing = [];
                for (const rel of registered) {
                    T.registered++;
                    registeredAll.add(rel);
                    if (!(rel in files)) { T.registeredMissing++; missing.push(rel); continue; }
                    fileChecks.push({ owner, rel, hash: files[rel] });
                }
                if (missing.length) add('data', 'text-registered-missing', `${owner}/${ip} 登记了 ${missing.length} 个卷／章文件，manifest 里没有`, { missing: missing.slice(0, 10) });
            }
            // 没被任何 index 登记的正文文件（pages.tsv、整理本 text/*.txt 这类旁路文件不算）
            const unregistered = Object.keys(files).filter((p) => !isTextIndexPath(p) && !registeredAll.has(p)
                && !p.endsWith('.tsv') && !p.startsWith('collated_edition/text/'));
            T.unregisteredFiles += unregistered.length;
            if (unregistered.length && indexPaths.length) add('info', 'text-unregistered', `${owner} 有 ${unregistered.length} 个文件没被 index 登记`, { examples: unregistered.slice(0, 5) });
        });
        await pool(fileChecks, concurrency, async ({ owner, rel, hash }) => {
            T.filesChecked++;
            const r = await http.request(`${h1}/text/${encodeURIComponent(owner)}/${insertHash(rel, hash)}`, { method: 'HEAD' });
            if (!r.ok) { T.filesUnreachable++; add(missKind(r), 'text-file-unreachable', `${owner}/${rel} 在 manifest 里，取不到（HTTP ${r.status}）`); }
        });
    }
    phases.text = Date.now() - tp;
    log(`全文：抽 ${T.ownersSampled} 个 owner，登记 ${T.registered}，缺 ${T.registeredMissing}，取不到 ${T.filesUnreachable}`);

    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - t0;
    return report;
}

// ─── 报告 ───

export function summarizeFindings(findings) {
    const byKind = { packaging: {}, data: {}, fetch: {}, info: {} };
    for (const f of findings) {
        const k = (byKind[f.kind] ??= {});
        (k[f.code] ??= []).push(f);
    }
    return byKind;
}

/**
 * 已知、已开修复卡的问题：照常进报告，但不让 job 变红（否则修好之前每次都红，真正的新问题会被淹没）。
 * 修好后从这里删掉对应 code。
 *   current-cdn-stale / current-version-cdn-stale：?v 只用 draft 仓 commit（overview#169 FX2）
 */
export const KNOWN_ISSUE_CODES = new Set(['current-cdn-stale', 'current-version-cdn-stale']);

export function hasFailures(report, failOn = 'packaging') {
    if (failOn === 'none') return false;
    const reqs = report.http?.requests ?? 0;
    if (reqs > 0 && (report.http.failures ?? 0) / reqs > FETCH_FAIL_RATIO) return true;
    return report.findings.some((f) => !KNOWN_ISSUE_CODES.has(f.code)
        && (f.kind === 'packaging' || (failOn === 'any' && f.kind === 'data')));
}

const n = (x) => (typeof x === 'number' ? x.toLocaleString('en-US') : String(x ?? '—'));
const sec = (ms) => `${(ms / 1000).toFixed(1)}s`;

export function renderMarkdown(report, { maxPerCode = 15 } = {}) {
    const L = [];
    const E = report.entries ?? {}, R = report.refs ?? {}, T = report.text ?? {}, C = report.counts ?? {};
    L.push(`## 数据巡检报告（DQ）`);
    L.push('');
    L.push(`- 站点：\`${report.base}\`，h1：\`${report.h1}\``);
    if (report.latest) L.push(`- latest.json：\`${report.latest.commitId}\`（bundle ${report.latest.bundleDate ?? '—'}）`);
    L.push(`- 抽样：条目 ${(report.entryRate * 100).toFixed(2)}%，全文 owner ${(report.textRate * 100).toFixed(2)}%，seed \`${report.seed}\`，并发 ${report.concurrency}`);
    L.push(`- 耗时：${sec(report.durationMs ?? 0)}（指针 ${sec(report.phases.pointers ?? 0)} ／ manifest ${sec(report.phases.manifest ?? 0)} ／ 条目 ${sec(report.phases.entries ?? 0)} ／ 引用 ${sec(report.phases.refs ?? 0)} ／ 全文 ${sec(report.phases.text ?? 0)}）`);
    L.push(`- 请求：${n(report.http.requests)} 次，重试 ${n(report.http.retries)}，429 ${n(report.http.throttled)}，最终失败 ${n(report.http.failures)}`);
    L.push('');
    L.push('### 总数与类型');
    L.push('');
    L.push(`manifest 条目总数 **${n(C.total)}**（${n(C.shards)} 个分片）`);
    L.push('');
    L.push('| 类型 | manifest（按 id 类型位） | current/meta.json |');
    L.push('|---|---:|---:|');
    for (const t of [...VALID_TYPES, 'unknown']) {
        if (t === 'unknown' && !C.byType?.unknown) continue;
        L.push(`| ${t} | ${n(C.byType?.[t] ?? 0)} | ${n(C.meta?.[t])} |`);
    }
    if (C.byStatus) L.push(`\n按状态位：${Object.entries(C.byStatus).map(([k, v]) => `${k} ${n(v)}`).join('，')}`);
    L.push('');
    L.push('### 抽样结果');
    L.push('');
    L.push('| 项 | 数 |');
    L.push('|---|---:|');
    L.push(`| 条目抽样 | ${n(E.sampled)} |`);
    L.push(`| h1 取不到／非 JSON | ${n(E.h1Bad)} |`);
    L.push(`| h1 内容哈希不符 | ${n(E.hashMismatch)} |`);
    L.push(`| id 与文件名不一致 | ${n(E.idMismatch)} |`);
    L.push(`| type 不合法 | ${n(E.typeInvalid)} |`);
    L.push(`| type 与 id 类型位不符 | ${n(E.typeBitMismatch)} |`);
    L.push(`| current 与 h1 逐字节一致 | ${n(E.currentMatch)} |`);
    L.push(`| current 与 h1 不一致 | ${n(E.currentDiffer)}（其中 CDN 旧缓存 ${n(E.currentCdnStale)}） |`);
    L.push(`| current 取不到 | ${n(E.currentMissing)} |`);
    L.push(`| 引用（${REF_FIELDS.join('／')}） | ${n(R.refs)}（去重 ${n(R.unique)}） |`);
    L.push(`| 经升格表解析 | ${n(R.resolvedViaPromotion)} |`);
    L.push(`| **悬空引用** | **${n(R.dangling)}** |`);
    L.push(`| 引用在 manifest 但取不到 | ${n(R.unreachable)} |`);
    L.push(`| 全文 owner 总数／抽样 | ${n(T.owners)} ／ ${n(T.ownersSampled)} |`);
    L.push(`| 抽样 index.json | ${n(T.indexes)}（坏 ${n(T.indexBad)}） |`);
    L.push(`| 登记卷／章文件 | ${n(T.registered)} |`);
    L.push(`| 登记了但 manifest 没有 | ${n(T.registeredMissing)} |`);
    L.push(`| manifest 有但取不到 | ${n(T.filesUnreachable)}（查了 ${n(T.filesChecked)}） |`);
    L.push(`| owner 不在条目 manifest | ${n(T.ownersNotInManifest)} |`);
    if (R.byField && Object.keys(R.byField).length) {
        L.push('');
        L.push(`引用分字段：${Object.entries(R.byField).map(([f, s]) => `${f} ${n(s.refs)}（悬空 ${n(s.dangling)}）`).join('，')}`);
    }
    const grouped = summarizeFindings(report.findings);
    for (const kind of ['packaging', 'data', 'fetch', 'info']) {
        const codes = grouped[kind];
        const total = Object.values(codes).reduce((s, l) => s + l.length, 0);
        L.push('');
        L.push(`### ${FINDING_KINDS[kind]}：${total}`);
        if (!total) { L.push(''); L.push('无。'); continue; }
        for (const [code, list] of Object.entries(codes)) {
            L.push('');
            L.push(`<details><summary><code>${code}</code> × ${list.length}</summary>`);
            L.push('');
            for (const f of list.slice(0, maxPerCode)) {
                L.push(`- ${f.message}${f.detail ? ` — \`${JSON.stringify(f.detail).slice(0, 300)}\`` : ''}`);
            }
            if (list.length > maxPerCode) L.push(`- ……另 ${list.length - maxPerCode} 条见 JSON 报告`);
            L.push('');
            L.push('</details>');
        }
    }
    L.push('');
    return L.join('\n');
}
