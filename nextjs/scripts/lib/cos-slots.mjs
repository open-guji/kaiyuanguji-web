/**
 * cos-slots.mjs — 三路 COS 同步（current/、h1 条目、h1 文本）共用一份并发预算，按各路「待传对象数」动态分配。
 *
 * 背景（overview#469、kaiyuanguji-web#275 评论「待查 2」）：三路在 deploy.yml 里并行跑，并发原来是静态切的
 * （current/ 36 ＋ h1 条目 12 ＋ h1 文本 32，总数 80）。平时只有一路有活，另外两路的名额白白闲着；
 * 全量变化（文本迁移、schema-v2）时 h1 条目 14.7 万个对象只有 12 个并发，10-07 那次 77 分钟没传完。
 *
 * 做法：总预算 total（默认 80）固定，每路在自己的计划算完、要开始传的时候，把「剩余待处理数」写进共享目录
 * （COS_PLAN_DIR/<路>.json，原子写）；各路在每次取下一个对象之前，按各路剩余数的比例算出自己此刻的份额，
 * 超了就等一等。没登记的路按 0 算（它还在打包），所以先开始的路一开始可以用满，对方登记后一次循环内让出——
 * 不需要等齐三路，平时的小计划不会被拖慢。
 *
 * 分配规则（allocateSlots，纯函数）：有活的路各保底 min（默认 4，且不超过它自己的剩余数），其余名额按
 * 「剩余数 − 保底」的比例分，不超过各路剩余数；分不完的名额再分给还没封顶的路。总和不超过 total。
 *
 * 总在途数不超预算：登记里还带各路**此刻的在途数**（inflight）和**声明的份额**（limit，份额一变立即写），
 * 一路的份额再受「总预算 − 别路占用」限制（占用 ＝ max(在途数, min(声明份额, 剩余数))）——新登记的一路要等先开始的
 * 那路把名额让出来（先降份额、在途任务跑完）才能涨上去，而不是两边同时满额（实测没有这条时瞬时总在途数到过 138）。
 * 别路占满时，每路仍保证至少 min 个，不会被饿死。
 *
 * 登记带时间戳：超过 ttlMs（默认 10 秒）没更新的登记当作 0（那一路进程死了），免得它占着名额不放。
 * 传输期间每 250 毫秒更新一次（见 h1-sync-core.mjs 的 runQueue）；进程退出时也会撤掉登记。
 *
 * 协调失效时退回静态：登记写不进去（连续两次）或登记目录读不了，这一路退回静态份额 fallback（默认 total/3，
 * slotAllocatorFromEnv 优先取 COS_CONCURRENCY——deploy.yml 里各路命令行上的 36／12／32）。否则各路看不见彼此，
 * 都当自己独占、各开满额，总并发会远超预算；退回静态份额则总数仍是各路静态份额之和（80）。写得进去了就自动恢复协调。
 *
 * 只在设了 COS_PLAN_DIR 时启用（CI 里由 deploy.yml 设）；没设就是原来的静态并发（本地跑脚本、单测不受影响）。
 */
import { mkdirSync, writeFileSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_TOTAL = 80;
export const DEFAULT_MIN = 4;
const DEFAULT_TTL_MS = 10_000;   // 登记超过这么久没更新（正常每 250 毫秒更新一次）就当那一路已死
const READ_CACHE_MS = 250;

/**
 * 把 total 个名额分给各路。
 * @param {Record<string, number>} pendings  路名 → 剩余待处理数（≤0 视为没活）
 * @returns {Record<string, number>}  只含有活的路；各路份额 ≤ 剩余数，总和 ≤ total
 */
export function allocateSlots(pendings, total = DEFAULT_TOTAL, min = DEFAULT_MIN) {
    const active = Object.entries(pendings)
        .map(([name, p]) => [name, Math.floor(Number(p))])
        .filter(([, p]) => Number.isFinite(p) && p > 0)
        .sort((a, b) => (a[0] < b[0] ? -1 : 1)); // 路名排序，结果确定
    const out = {};
    if (active.length === 0) return out;

    // 活着的路比名额还多（不会发生：三路）：每路至少 1 个，按剩余数从多到少给
    if (active.length >= total) {
        const byPending = [...active].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
        byPending.forEach(([name], i) => { out[name] = i < total ? 1 : 0; });
        return out;
    }

    // 保底：每路 min 个，但不超过它自己的剩余数；保底总和超过 total 时按 total/路数 均分向下取整（至少 1）
    let base = Object.fromEntries(active.map(([n, p]) => [n, Math.min(p, min)]));
    const sumBase = Object.values(base).reduce((s, v) => s + v, 0);
    if (sumBase > total) {
        const each = Math.max(1, Math.floor(total / active.length));
        base = Object.fromEntries(active.map(([n, p]) => [n, Math.min(p, each)]));
    }
    for (const [n] of active) out[n] = base[n];

    // 剩余名额按「剩余数 − 已给」的比例分，封顶后再把没分完的分给没封顶的（水位填充）
    let left = total - Object.values(out).reduce((s, v) => s + v, 0);
    const pendingOf = Object.fromEntries(active);
    while (left > 0) {
        const open = active.filter(([n]) => out[n] < pendingOf[n]);
        if (open.length === 0) break;
        const weights = open.map(([n]) => pendingOf[n] - out[n]);
        const sumW = weights.reduce((s, v) => s + v, 0);
        // 按比例取整，余数按小数部分从大到小补
        const raw = open.map(([n], i) => ({ n, give: (left * weights[i]) / sumW }));
        let given = 0;
        for (const r of raw) {
            const g = Math.min(Math.floor(r.give), pendingOf[r.n] - out[r.n]);
            out[r.n] += g;
            given += g;
        }
        let rest = left - given;
        const order = [...raw].sort((a, b) => (b.give - Math.floor(b.give)) - (a.give - Math.floor(a.give)) || (a.n < b.n ? -1 : 1));
        for (const r of order) {
            if (rest <= 0) break;
            if (out[r.n] < pendingOf[r.n]) { out[r.n] += 1; rest -= 1; given += 1; }
        }
        if (given === 0) break; // 没有可分的了
        left -= given;
    }
    return out;
}

/**
 * 一路同步的分配器：publish() 登记自己的剩余数，limit() 给出自己此刻的并发份额。
 * @param {{name: string, dir: string, total?: number, min?: number, ttlMs?: number, now?: () => number}} o
 */
export function createSlotAllocator({
    name, dir, total = DEFAULT_TOTAL, min = DEFAULT_MIN, ttlMs = DEFAULT_TTL_MS, now = Date.now,
    fallback = Math.max(min, Math.floor(total / 3)), warn = console.warn,
}) {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${name}.json`);
    let mine = 0;          // 自己的剩余待处理数
    let mineInflight = 0;  // 自己此刻的在途数
    let declared = 0;      // 自己最近一次算出的份额（写进登记，让别路知道我「被允许」占多少）
    let cache = null;      // { at, others: { name: { pending, inflight, limit } } }
    let writeFailures = 0; // 连续写登记失败的次数
    let degraded = false;  // 协调用不了（登记写不进去／读不了）：各路退回静态份额 fallback，免得各自当作独占而超预算
    const enterDegraded = (why) => {
        if (!degraded) warn(`  ⚠ 并发协调不可用（${why}），${name} 退回静态并发 ${fallback}（总预算 ${total} 由各路静态份额之和保证）`);
        degraded = true;
    };

    function write() {
        try {
            const tmp = `${file}.${process.pid}.tmp`;
            writeFileSync(tmp, JSON.stringify({ name, pending: mine, inflight: mineInflight, limit: declared, at: now() }));
            renameSync(tmp, file);
            writeFailures = 0;
            degraded = false; // 写得进去了：恢复协调
        } catch (e) {
            // 偶发一次不处理；连续两次写不进去，别路就看不见我的登记，各自会当自己独占——退回静态份额
            if (++writeFailures >= 2) enterDegraded(`写登记失败：${e.code || e.message}`);
        }
    }

    /** 登记：pending＝剩余待处理数（含在途），inflight＝此刻在途数。 */
    function publish(pending, inflight = 0) {
        mine = Math.max(0, Math.floor(pending));
        mineInflight = Math.max(0, Math.floor(inflight));
        if (mine === 0) declared = 0;
        cache = null;
        write();
    }

    function readOthers() {
        const out = {};
        let names = [];
        try { names = readdirSync(dir); } catch (e) { enterDegraded(`读登记目录失败：${e.code || e.message}`); return out; }
        const t = now();
        for (const f of names) {
            if (!f.endsWith('.json') || f === `${name}.json`) continue;
            try {
                const d = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
                if (typeof d?.name === 'string' && Number.isFinite(d.pending) && Number.isFinite(d.at) && t - d.at <= ttlMs) {
                    out[d.name] = {
                        pending: d.pending,
                        inflight: Number.isFinite(d.inflight) ? Math.max(0, d.inflight) : 0,
                        limit: Number.isFinite(d.limit) ? Math.max(0, d.limit) : 0,
                    };
                }
            } catch { /* 读到半截或损坏的文件：当它不存在 */ }
        }
        return out;
    }

    /**
     * 自己此刻的并发份额（至少 1）：按各路剩余数分到的份额，再受「总预算 − 别路占用」限制（但至少保底 min）。
     * 别路占用 ＝ max(它的在途数, min(它声明的份额, 它的剩余数))：在途数每 250 毫秒才更新，刚起跑的一路在途数还是 0，
     * 但它声明的份额已经写进登记（份额一变就立即写），所以后登记的一路不会趁这个空档也满额起跑。
     * 自己没有剩余时也给 min，免得刚登记前的空档被卡死。
     */
    function limit() {
        const t = now();
        if (!cache || t - cache.at > READ_CACHE_MS) cache = { at: t, others: readOthers() };
        if (degraded) return Math.max(1, fallback);
        const pendings = { [name]: mine };
        let othersBusy = 0;
        for (const [n, o] of Object.entries(cache.others)) {
            pendings[n] = o.pending;
            othersBusy += Math.max(o.inflight, Math.min(o.limit, o.pending));
        }
        const share = allocateSlots(pendings, total, min)[name] ?? min;
        const room = total - othersBusy;
        const v = Math.max(1, Math.min(share, Math.max(Math.min(share, min), room)));
        if (mine > 0 && v !== declared) { declared = v; write(); } // 份额一变立即登记
        return v;
    }

    function release() {
        mine = 0; mineInflight = 0; declared = 0;
        write();
        try { rmSync(file, { force: true }); } catch { /* ignore */ }
    }

    return { name, total, publish, limit, release };
}

/** 设了 COS_PLAN_DIR 才启用（返回分配器），否则返回 null（用原来的静态并发）。 */
export function slotAllocatorFromEnv(name, env = process.env) {
    const dir = env.COS_PLAN_DIR;
    if (!dir) return null;
    const total = Number(env.COS_TOTAL_BUDGET);
    const minSlots = Number(env.COS_MIN_SLOTS);
    const staticShare = Number(env.COS_CONCURRENCY);
    try {
        return createSlotAllocator({
            name, dir,
            total: Number.isInteger(total) && total >= 1 && total <= 500 ? total : DEFAULT_TOTAL,
            min: Number.isInteger(minSlots) && minSlots >= 1 && minSlots <= 50 ? minSlots : DEFAULT_MIN,
            ...(Number.isInteger(staticShare) && staticShare >= 1 && staticShare <= 500 ? { fallback: staticShare } : {}),
        });
    } catch (e) {
        console.warn(`  ⚠ 并发分配器初始化失败（${e.message}），退回静态并发`);
        return null;
    }
}
