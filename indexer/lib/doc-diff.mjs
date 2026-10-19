/**
 * 增量更新的纯逻辑（overview#561 二期）：文档哈希、两代哈希比对、差量 manifest 校验。
 *
 * 口径：不按 git diff 推算「哪些条目受影响」（分类表、版本数这类连带推不全），而是 runner 每次全量渲染文档，
 * 和上次入库那一代逐条比哈希——渲染结果变了的文档一个不漏，派生逻辑零重复实现。
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, readFileSync } from 'node:fs';
import { createGunzip, createGzip } from 'node:zlib';
import { once } from 'node:events';

/** 键排序后的 JSON（数组保持顺序）：同一份内容不论键顺序都得到同一个串。 */
export function canonicalJson(v) {
    if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
    if (v && typeof v === 'object') {
        return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
    }
    return JSON.stringify(v === undefined ? null : v);
}

/** 文档内容哈希：sha1(规范化 JSON) 前 16 位十六进制。 */
export function docHash(doc) {
    return createHash('sha1').update(canonicalJson(doc)).digest('hex').slice(0, 16);
}

/**
 * 两代 {id → hash} 比对。base／next 是 Map 或普通对象。
 * 返回 { upsert:Set（新增＋内容变了）, del:Set（上一代有、这一代没有）, added, changed, unchanged }。
 */
export function diffHashes(base, next) {
    const b = base instanceof Map ? base : new Map(Object.entries(base || {}));
    const n = next instanceof Map ? next : new Map(Object.entries(next || {}));
    const upsert = new Set(), del = new Set();
    let added = 0, changed = 0, unchanged = 0;
    for (const [id, h] of n) {
        const old = b.get(id);
        if (old === undefined) { upsert.add(id); added++; }
        else if (old !== h) { upsert.add(id); changed++; }
        else unchanged++;
    }
    for (const id of b.keys()) if (!n.has(id)) del.add(id);
    return { upsert, del, added, changed, unchanged };
}

/** 变动比例：(upsert+delete) / max(上一代条数, 1)。 */
export function changeRatio(d, baseSize) {
    return (d.upsert.size + d.del.size) / Math.max(baseSize, 1);
}

export const FALLBACK = {
    STATE_MISSING: 'STATE_MISSING_OR_CORRUPT',
    BASE_MISSING: 'BASE_HASHES_MISSING',
    VERSION: 'INDEXER_VERSION_CHANGED',
    RATIO: 'CHANGE_RATIO_HIGH',
};

/**
 * 搜索机侧：差量能不能打到当前线上这一代上。返回问题数组，空＝可以。
 * state 是 /opt/indexer/state.json；差量必须是以 state 记的那一代为基线算出来的，否则会漏改或重复删。
 */
export function deltaProblems(delta, state, { indexes } = {}) {
    const p = [];
    if (!delta || typeof delta !== 'object') return ['delta manifest 不是对象'];
    if (delta.schema !== 1 || delta.mode !== 'incremental') p.push(`delta manifest schema=${delta.schema} mode=${delta.mode}，只认 schema 1／incremental`);
    if (!state) p.push(`${FALLBACK.STATE_MISSING}：搜索机上没有 state.json（还没有可作基线的一代，先跑一次全量或 --adopt）`);
    else {
        if (!state.renderRunId) p.push(`${FALLBACK.STATE_MISSING}：state.json 没有 renderRunId（旧版全量写的，先 --adopt 一代）`);
        else if (String(delta.base?.renderRunId) !== String(state.renderRunId)) {
            p.push(`差量的基线是 run ${delta.base?.renderRunId}，线上这一代是 run ${state.renderRunId}：基线对不上，不能打`);
        }
        if (state.indexerVersion && delta.indexerVersion !== state.indexerVersion) {
            p.push(`${FALLBACK.VERSION}：差量 indexerVersion=${delta.indexerVersion}，线上 ${state.indexerVersion}`);
        }
    }
    if (!delta.renderRunId) p.push('delta manifest 缺 renderRunId');
    for (const i of indexes || Object.keys(delta.expectedCounts || {})) {
        if (typeof delta.expectedCounts?.[i] !== 'number') p.push(`expectedCounts.${i} 缺失`);
        if (typeof delta.upserts?.[i] !== 'number' || typeof delta.deletes?.[i] !== 'number') p.push(`upserts／deletes.${i} 缺失`);
        if (delta.upserts?.[i] > 0 && !/^[0-9a-f]{64}$/.test(delta.sha256?.[i] || '')) p.push(`sha256.${i} 缺失或格式不对`);
    }
    return p;
}

// ─── 文件读写（runner 与搜索机共用） ───

export async function writeJsonGz(path, obj) {
    const gz = createGzip({ level: 6 });
    const out = createWriteStream(path);
    gz.pipe(out);
    gz.end(JSON.stringify(obj));
    await once(out, 'finish');
}

export async function readJsonGz(path) {
    const chunks = [];
    const s = createReadStream(path).pipe(createGunzip());
    for await (const c of s) chunks.push(c);
    return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
}

export function readJsonFile(path) {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf-8')) : null;
}
