/**
 * COS 数据同步的「要不要传」判定（overview#293 第 2 项，部署提速）。
 *
 * 背景：一次部署里三次 COS 同步（current/、h1/ 条目、h1/ 文本）约 8 分钟；三个数据仓都没变时，
 * 传上去的东西和线上一模一样，是白花的时间。这里只做纯逻辑（可单测），联网的部分在
 * ../cos-sync-decision.mjs。
 *
 * 只比三仓 commit 不够，会漏两种情况（所以多了下面两个条件）：
 *   ① 网站自己的打包脚本改了、数据仓没改：总目／阅读首页索引、搜索分片、h1 哈希都由
 *      nextjs/scripts 生成，脚本一改产物就变（overview#267 里我们改过好几次），此时 commit 相同
 *      但 current/ 里的东西该更新。所以把「打包脚本的指纹」也纳入比对。
 *   ② 上一次同步没完整成功：sync-to-cos.mjs 在 current/ 传完后就写了 latest.json，而 h1 两步是
 *      continue-on-error（失败只警告）。只看 latest.json 会把「h1 没传全」永远当成已同步。
 *      所以另写一个标记文件 _deploy/sync-marker.json，只在三次同步都成功后才写；判定要它和
 *      线上 latest.json 的三仓 commit 都对得上。
 * 任何读不到、对不上、字段缺失的情况一律按「有变化」照常同步。
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

/** 判定用的三个数据仓 commit（与 latest.json 里的字段同名） */
export const COMMIT_FIELDS = ['fullCommitId', 'productionCommitId', 'textCommitId'];

/** 网站里另一个参与打包的源文件（build-search-index.mjs 从这里 import）。其余都在 nextjs/scripts 下 */
const EXTRA_FINGERPRINT_FILES = ['nextjs/src/lib/search/lite.js', 'nextjs/package-lock.json'];

function walkFiles(dir) {
    const out = [];
    for (const name of readdirSync(dir).sort()) {
        if (name === 'node_modules') continue;
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) out.push(...walkFiles(full));
        else out.push(full);
    }
    return out;
}

/**
 * 打包脚本指纹：nextjs/scripts 下所有非测试文件、search/lite.js、package-lock.json 的内容哈希。
 * 偏保守——脚本目录里任何非测试文件变了（哪怕只是同步脚本）都会让指纹变、触发一次照常同步，
 * 代价只是多花一次时间，不会漏传。
 */
export function computeBundleFingerprint(repoRoot) {
    const files = [];
    const scriptsDir = join(repoRoot, 'nextjs', 'scripts');
    if (existsSync(scriptsDir)) {
        for (const f of walkFiles(scriptsDir)) {
            if (/\.test\.[cm]?[jt]sx?$/.test(f)) continue;
            files.push(f);
        }
    }
    for (const rel of EXTRA_FINGERPRINT_FILES) {
        const f = join(repoRoot, rel);
        if (existsSync(f)) files.push(f);
    }
    const h = createHash('sha256');
    for (const f of files.sort()) {
        h.update(relative(repoRoot, f).split('\\').join('/'));
        h.update('\0');
        h.update(createHash('sha256').update(readFileSync(f)).digest('hex'));
        h.update('\n');
    }
    return h.digest('hex');
}

function nonEmptyString(v) {
    return typeof v === 'string' && v.trim() !== '';
}

/**
 * @param {{marker: object|null, latest: object|null, current: {fullCommitId, productionCommitId, textCommitId, bundleFingerprint}}} args
 *   marker：线上 _deploy/sync-marker.json；latest：线上 latest.json；current：这次要发的
 * @returns {{skip: boolean, reason: string}}
 */
export function decideSync({ marker, latest, current }) {
    if (!current || !COMMIT_FIELDS.every((k) => nonEmptyString(current[k])) || !nonEmptyString(current.bundleFingerprint)) {
        return { skip: false, reason: '这次的三仓 commit 或打包指纹不全，无法比对' };
    }
    if (!marker || typeof marker !== 'object') {
        return { skip: false, reason: '线上没有同步标记（首次，或上次同步没完整成功）' };
    }
    if (!latest || typeof latest !== 'object') {
        return { skip: false, reason: '读不到线上 latest.json' };
    }
    for (const k of COMMIT_FIELDS) {
        if (marker[k] !== current[k]) return { skip: false, reason: `${k} 与上次同步的不同` };
        if (latest[k] !== current[k]) return { skip: false, reason: `线上 latest.json 的 ${k} 与这次的不同` };
    }
    if (marker.bundleFingerprint !== current.bundleFingerprint) {
        return { skip: false, reason: '打包脚本（或其依赖）有改动，产物可能变了' };
    }
    return { skip: true, reason: '三仓 commit 与打包脚本都和上次完整同步时一致' };
}

/** 同步标记的内容：只在三次同步都成功后写 */
export function buildMarker(current, { webCommitId = '', now = new Date() } = {}) {
    return {
        version: 1,
        fullCommitId: current.fullCommitId,
        productionCommitId: current.productionCommitId,
        textCommitId: current.textCommitId,
        bundleFingerprint: current.bundleFingerprint,
        webCommitId,
        syncedAt: now.toISOString(),
    };
}

/**
 * 数据没变时的 latest.json：以线上现有的为底，只改 webCommitId（promote 靠它决定上正式站的代码）。
 * 其它字段（commitId、cacheKey、bundleDate……）原样保留，不丢。线上的读不出来就抛错，由调用方退回照常同步。
 */
export function mergeLatestForUnchangedData(remoteLatest, { webCommitId }) {
    if (!remoteLatest || typeof remoteLatest !== 'object' || Array.isArray(remoteLatest)) {
        throw new Error('线上 latest.json 不是对象');
    }
    if (!nonEmptyString(remoteLatest.commitId) || !nonEmptyString(remoteLatest.cacheKey)) {
        throw new Error('线上 latest.json 缺 commitId／cacheKey，不能当底');
    }
    if (!nonEmptyString(webCommitId)) throw new Error('缺 webCommitId');
    return { ...remoteLatest, webCommitId };
}

function joinKey(...parts) {
    return parts.filter(Boolean).map((p) => String(p).replace(/^\/+|\/+$/g, '')).join('/');
}
export const markerKey = (prefix) => joinKey(prefix, '_deploy', 'sync-marker.json');
export const latestKey = (prefix) => joinKey(prefix, 'latest.json');

/** COS 并发上限：环境变量 COS_CONCURRENCY（正整数），缺省 fallback。三次同步并行时各自调小，总数不超过原来的 80 */
export function cosConcurrency(fallback = 80, env = process.env) {
    const n = Number(env.COS_CONCURRENCY);
    return Number.isInteger(n) && n >= 1 && n <= 500 ? n : fallback;
}
