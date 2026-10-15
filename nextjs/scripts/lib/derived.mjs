/**
 * derived.mjs — schema-v2 的 build 产物（`build/build_derived.py --out <dir>`）读取层（overview#458）。
 *
 * 契约：book-index schema-v2 的 SCHEMA.md「附一·乙」。deploy 在打包前于检出的 book-index 上跑
 * build_derived.py，产物写到 BOOK_INDEX_DERIVED_DIR；打包脚本经本模块读。
 *
 * 严格模式（B5-3.2，GUJI-299，默认）：必须设 BOOK_INDEX_DERIVED_DIR，条目只读 `entry/<id>.json`
 * （源记录＋`_` 派生字段，是源的超集）。没设目录 → readEntryDoc 直接抛错；产物里缺条目 → 不再回退源档，
 * 计入 missing，汇总判闸时失败（reportEntryReads().fail）。
 * 本地开发另设显式开关 `ALLOW_SOURCE_FALLBACK=1`：恢复旧的双兼容（没设目录读源档；缺条目回退源档，只警告）。
 * CI 与搜索机不得设该开关。
 */
import { appendFileSync, existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

const LEVELS = ['l1', 'l2', 'l3', 'l4'];

/** 本地开发开关：ALLOW_SOURCE_FALLBACK=1 才允许读源档（CI／搜索机不设） */
export function sourceFallbackAllowed(env = process.env) {
    return /^(1|true|yes)$/i.test((env.ALLOW_SOURCE_FALLBACK ?? '').trim());
}

/** 严格模式下没设产物目录 → 抛错，写明缺什么、怎么办 */
export function assertDerivedDir(env = process.env) {
    if (derivedDir(env) === null && !sourceFallbackAllowed(env)) {
        throw new Error(
            '缺 BOOK_INDEX_DERIVED_DIR：打包必须读 build_derived.py 的产物（entry/<id>.json）。'
            + 'CI 在打包前跑 `python3 build/build_derived.py --out <dir>` 并 export 该变量；本地开发可设 ALLOW_SOURCE_FALLBACK=1 读源档。',
        );
    }
}

/** 产物目录；没设返回 null */
export function derivedDir(env = process.env) {
    const d = env.BOOK_INDEX_DERIVED_DIR;
    return d && d.trim() ? resolve(d.trim()) : null;
}

/** 产物里某个相对路径的绝对路径；没设产物目录或文件不存在返回 null */
export function derivedPath(rel, dir = derivedDir()) {
    if (!dir) return null;
    const p = join(dir, rel);
    return existsSync(p) ? p : null;
}

/**
 * 「读产物命中／回退读源档」计数（闸：现在无法证明打包已全量走产物，见 overview 旧字段盘点 2026-10-10）。
 * 按调用方标签（stat）分桶；只有设了产物目录（dir 非 null）的读才计，旧路径（没设）不计入闸。
 */
const entryReadStats = new Map();

function noteEntryRead(stat, kind) {
    const b = entryReadStats.get(stat) ?? { hit: 0, fallback: 0, missing: 0 };
    b[kind]++;
    entryReadStats.set(stat, b);
}

/** 当前计数快照：{ [stat]: { hit, fallback, missing } } */
export function entryReadStatsSnapshot() {
    return Object.fromEntries([...entryReadStats].map(([k, v]) => [k, { ...v }]));
}

export function resetEntryReadStats() {
    entryReadStats.clear();
}

/**
 * 读条目详情：产物 `entry/<id>.json`；缺条目＝null 并计 missing（严格模式不回退源档）。ALLOW_SOURCE_FALLBACK=1 时缺则读源档 `<root>/<path>`。
 * @param {{ id?: string, srcPath?: string, dir?: string | null, stat?: string }} args stat：计数标签（调用方名），默认 'entry'
 * @returns {{ doc: any, derived: boolean } | null} 没有返回 null；JSON 坏了抛错（交给调用方按原有方式报）
 */
export function readEntryDoc({ id, srcPath, dir = derivedDir(), stat = 'entry' }) {
    const lenient = sourceFallbackAllowed();
    if (!dir && !lenient) assertDerivedDir();
    const dp = id ? derivedPath(join('entry', `${id}.json`), dir) : null;
    if (dp) {
        const doc = JSON.parse(readFileSync(dp, 'utf-8'));
        if (dir) noteEntryRead(stat, 'hit');
        return { doc, derived: true };
    }
    if (lenient && srcPath && existsSync(srcPath)) {
        const doc = JSON.parse(readFileSync(srcPath, 'utf-8'));
        if (dir) noteEntryRead(stat, 'fallback');
        return { doc, derived: false };
    }
    if (dir) noteEntryRead(stat, 'missing');
    return null;
}

/**
 * 汇总并判闸。默认严格：没设产物目录、或回退源档／缺条目 >0 都失败；ALLOW_SOURCE_FALLBACK=1（本地）只警告。
 * STRICT_DERIVED 不再起作用（严格已是默认；CI 里残留的 STRICT_DERIVED=1 无害）。
 * @returns {{ enabled: boolean, hit: number, fallback: number, missing: number, strict: boolean, fail: boolean, lines: string[], warnings: string[] }}
 */
export function summarizeEntryReads(env = process.env, stats = entryReadStatsSnapshot()) {
    const enabled = derivedDir(env) !== null;
    const total = { hit: 0, fallback: 0, missing: 0 };
    const lines = [];
    for (const [k, v] of Object.entries(stats)) {
        total.hit += v.hit;
        total.fallback += v.fallback;
        total.missing += v.missing;
        lines.push(`  ${k}: 命中产物 ${v.hit}，回退源档 ${v.fallback}，两处都没有 ${v.missing}`);
    }
    const strict = !sourceFallbackAllowed(env);
    const warnings = [];
    if (!enabled && strict) warnings.push('derived 闸：没设 BOOK_INDEX_DERIVED_DIR（严格模式必须读 build_derived 产物；本地可设 ALLOW_SOURCE_FALLBACK=1）');
    if (enabled && total.fallback > 0) {
        warnings.push(`derived 闸：有 ${total.fallback} 次读条目回退到源档（产物 entry/ 缺这些条目）${strict ? '' : '；ALLOW_SOURCE_FALLBACK=1，仅警告'}`);
    }
    if (enabled && total.missing > 0) {
        warnings.push(`derived 闸：有 ${total.missing} 次读条目在产物里找不到${strict ? '' : '；ALLOW_SOURCE_FALLBACK=1，仅警告'}`);
    }
    const fail = strict && (!enabled || total.fallback > 0 || total.missing > 0);
    return { enabled, ...total, strict, fail, lines, warnings };
}

/**
 * 打包结束调用：打印汇总（设了 GITHUB_STEP_SUMMARY 时同时追加一段），回退时 console.warn；
 * 返回是否应失败（调用方决定 process.exit(1)）。没设产物目录、也没读过时什么都不打。
 */
export function reportEntryReads({ env = process.env, log = console.log, warn = console.warn, stats = entryReadStatsSnapshot() } = {}) {
    const r = summarizeEntryReads(env, stats);
    if (!r.enabled && !r.lines.length) {
        if (r.fail) for (const w of r.warnings) warn(`⚠ ${w}`);
        return r;
    }
    const head = `DER  条目读取：命中产物 ${r.hit}，回退源档 ${r.fallback}，两处都没有 ${r.missing}（${r.enabled ? '产物模式' : '未设产物目录'}${r.strict ? '，严格' : '，ALLOW_SOURCE_FALLBACK'}）`;
    log(head);
    for (const l of r.lines) log(l);
    for (const w of r.warnings) warn(`⚠ ${w}`);
    const sumFile = env.GITHUB_STEP_SUMMARY;
    if (sumFile && r.enabled) {
        try {
            appendFileSync(sumFile, `### derived 命中数\n\n- 命中产物 ${r.hit}，回退源档 ${r.fallback}，两处都没有 ${r.missing}\n${r.warnings.map((w) => `- ⚠ ${w}\n`).join('')}\n`);
        } catch {
            /* 写汇总失败不影响打包 */
        }
    }
    return r;
}

/**
 * 检索索引目录：产物有 `index/` 就用产物的（源仓 `index/` 在 schema-v2 之后不再是真源），否则用源仓的。
 */
export function indexDirFor(prodDir, dir = derivedDir()) {
    if (dir && existsSync(join(dir, 'index'))) return join(dir, 'index');
    return join(prodDir, 'index');
}

/** 分类表（旧格式 classific.json）：产物里有（由 classification/zongmu/tree.json 生成）就用，否则源仓的 */
export function taxonomyFileFor(prodDir, dir = derivedDir()) {
    return derivedPath('classific.json', dir) ?? join(prodDir, 'classific.json');
}

/**
 * 条目的分类，统一成旧形状 `{ l1, l2, l3, l4, source }`，或 null：
 * 取 `_classifications[]`（有多个分类法时优先 zongmu，否则取第一个有 l1 的）；没有返回 null（旧 `classification` 回退已删）。
 */
export function classificationOf(d) {
    const list = Array.isArray(d?._classifications) ? d._classifications.filter((c) => c && typeof c === 'object') : [];
    const pick = list.find((c) => c.scheme === 'zongmu' && c.l1) ?? list.find((c) => c.l1);
    if (pick) {
        const out = {};
        for (const k of LEVELS) out[k] = typeof pick[k] === 'string' ? pick[k] : '';
        if (pick.source) out.source = pick.source;
        return out;
    }
    return null;
}
