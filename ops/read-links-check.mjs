#!/usr/bin/env node
/**
 * read-links-check.mjs — 部署后抽检：阅读首页（/read）列出的卡片，点进去真能读（overview#306）
 *
 * 背景：阅读索引曾把「有外部文本链接」当成「站内有全文」，首页 55.9% 的卡片点开是 404。
 * 构建期已逐卡核对产物（nextjs/scripts/build-read-index.mjs 的 verifyItems），这里是上线后的外部复核：
 *   read/tree.json 的每个一级节点随机抽 N 张（默认 20；先随机挑页、再从页里抽，不只看第 1 页）
 *   ＋ read/featured.json（整理本、Book 全文）全部；
 *   每张卡：① /read/<id> 页面（主版本）与 /read/<id>/<key>（其他版本）200；② 数据里目录（index）与首章文件都 200。
 *   页面与数据文件回 503（EdgeOne 回源超时页，overview#322）、522／524／525（overview#484）或连接失败时按 retryDelaysMs 退避重试（默认 2s／5s／10s，最多 3 次），
 *   仍不是 200 才记失败；重试过才通过的另记在 retried 里写进 summary——它只是兜底，根因在阅读页的首次渲染。
 *   overview#341：verify 成了自动上正式站的闸门，新部署后阅读页冷启动（ISR 首次渲染超回源时限）会误拦。所以：
 *     ① 正式抽检前先预热（warm）：把这次要查的阅读页低并发 GET 一遍，结果不计成败，只记首次状态与耗时写进 summary
 *        （这份数据也是 #322 冷启动的实测）；
 *     ② 重试后通过的占比超过 warnRatio（默认 20%）只告警（summary ＋ ::warning::），不拦发布。
 *   数据路径与阅读页同源（nextjs/src/lib/server/reader-check.ts，只认新结构 overview#307）：
 *     items/<id>/manifest.json → versions 逐份查 items/<id>/<key>/index.json → chapters[0].file
 *     （.md→.txt；has_json 的章查同名 .json，md 可缺）；manifest 里不得有 visibility=internal。
 *   阅读首页列出的卡片都必须有 manifest.json（没有就是数据缺失，记失败）。
 *
 * 只发 GET，无依赖、无 secret。CLI：
 *   node ops/read-links-check.mjs --target https://www.kaiyuanguji.com --data https://data.kaiyuanguji.com [--per-node 20] [--seed 1]
 * 环境变量 TARGET／DATA_BASE 同名（verify.yml 已设）。有失败退出码 1，并在 GitHub Actions 里写 job summary。
 */
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { mulberry32 } from './dq-lib.mjs';
import { chapterTxtFile, firstChapterOf, isInternal, isTextKey } from '../nextjs/scripts/lib/text-layout.mjs';

/** 边缘瞬时错误：503 回源超时页、522 连接回源超时、524 回源读超时、525 边缘与源站 TLS 握手失败（overview#484）；都按可重试处理 */
export const EDGE_TRANSIENT = new Set([503, 522, 524, 525]);

/** 非 200 响应里 EdgeOne 排障用的头，拼成 `EO-LOG-UUID=… Eo-Cache-Status=… Date=…`；没有的头不写 */
export function edgeHeaders(res) {
    const h = res?.headers;
    if (!h || typeof h.get !== 'function') return '';
    return ['EO-LOG-UUID', 'Eo-Cache-Status', 'Date'].map((k) => [k, h.get(k)]).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(' ');
}

/** 带种子从数组里抽 n 个（不足则全取），顺序稳定 */
export function pickSome(items, n, rand) {
    const arr = [...items];
    const k = Math.min(n, arr.length);
    for (let i = 0; i < k; i++) {
        const j = i + Math.floor(rand() * (arr.length - i));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr.slice(0, k);
}

/** 分位数（ms 数组，已排序或未排序均可） */
export function percentile(values, p) {
    if (!values.length) return 0;
    const v = [...values].sort((a, b) => a - b);
    return v[Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1))];
}

/**
 * @param {{ target: string, dataBase: string, fetchImpl?: typeof fetch, perNode?: number, pageSize?: number, seed?: number, concurrency?: number,
 *   retryDelaysMs?: number[], warm?: boolean, warmConcurrency?: number, warmTimeoutMs?: number, sleep?: (ms: number) => Promise<void> }} o
 * @returns {Promise<{ checked: number, pagesChecked: number, failures: { id: string, what: string, detail: string }[], retried: string[], retriedData: string[],
 *   warm: { pages: number, notOk: { url: string, status: number }[], ms: number[] } | null }>}
 */
export async function checkReadLinks({ target, dataBase, fetchImpl = fetch, perNode = 20, pageSize = 20, seed = Date.now() % 2 ** 31, concurrency = 6,
    retryDelaysMs = [2000, 5000, 10000], warm = true, warmConcurrency = 6, warmTimeoutMs = 60_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    const cur = `${dataBase.replace(/\/$/, '')}/current`;
    const site = target.replace(/\/$/, '');
    const rand = mulberry32(seed);
    const bust = `t=${Date.now()}`;

    // 网络错误、JSON 解析失败都不抛出，记成 { ok: false }（status 0），由调用方记为失败
    // 非 200 时把 EdgeOne 的 EO-LOG-UUID／Eo-Cache-Status／Date 带上，失败行里留给人去 EdgeOne 日志按 UUID 查（overview#484）
    async function get(url, asJson, timeoutMs) {
        try {
            const init = { headers: { 'cache-control': 'no-cache' } };
            if (timeoutMs) init.signal = AbortSignal.timeout(timeoutMs);
            const res = await fetchImpl(url, init);
            if (!res.ok) return { ok: false, status: res.status, hdr: edgeHeaders(res) };
            return { ok: true, status: res.status, body: asJson ? await res.json() : undefined };
        } catch (e) {
            // JSON 解析失败是永久错误（响应已到），不是传输失败，标 permanent 不重试
            return { ok: false, status: 0, error: e.message, permanent: e instanceof SyntaxError };
        }
    }
    const why = (r) => (r.status ? `HTTP ${r.status}` : `请求失败：${r.error}`)
        + (r.attempts ? `（${r.retriedFrom}后重试 ${r.attempts} 次仍失败）` : '')
        + (r.hdr ? ` [${r.hdr}]` : '');
    /**
     * 503（EdgeOne 回源超时页）、522／524／525（边缘回源超时／握手失败，overview#484）或连接失败（status 0，回源太久被掐断，测试站 10-01 实测）
     * 按 retryDelaysMs 退避重试；阅读页与数据文件都一样。重试后通过的记进 retried（页面）／retriedData（数据）。
     * 404、500 等确定的错误不重试。
     */
    const retried = [];
    const retriedData = [];
    let pagesChecked = 0;
    const transient = (r) => !r.permanent && (r.status === 0 || EDGE_TRANSIENT.has(r.status));
    async function getRetrying(url, asJson, into) {
        const first = await get(url, asJson);
        let r = first;
        let attempts = 0;
        let hdr = first.hdr; // 重试途中拿到过的 EdgeOne 头留着，最后一次没带头（如连接失败）也不丢
        while (transient(r) && attempts < retryDelaysMs.length) {
            await sleep(retryDelaysMs[attempts++]);
            r = await get(url, asJson);
            hdr = r.hdr || hdr;
        }
        if (attempts === 0) return r;
        if (r.ok) { into.push(url); return r; }
        return { ...r, hdr, retriedFrom: first.status === 0 ? '连接失败' : String(first.status), attempts };
    }
    const getPage = (url) => { pagesChecked++; return getRetrying(url, false, retried); };
    const getData = (url, asJson) => getRetrying(url, asJson, retriedData);
    const json = async (rel) => getData(`${cur}/${rel}?${bust}`, true);

    const failures = [];
    const fail = (id, what, detail) => failures.push({ id, what, detail });

    const tree = await json('read/tree.json');
    const featured = await json('read/featured.json');
    // 顶层清单读不了：记成失败返回（调用方照常渲染、写 summary 再退出），不抛
    if (!tree.ok || !Array.isArray(tree.body)) fail('read/tree.json', '数据', tree.ok ? '不是数组' : `read/tree.json → ${why(tree)}`);
    if (!featured.ok || typeof featured.body !== 'object' || !featured.body) fail('read/featured.json', '数据', featured.ok ? '不是对象' : `read/featured.json → ${why(featured)}`);
    if (failures.length) return { checked: 0, pagesChecked: 0, failures, retried, retriedData, warm: null };

    // 待查的卡：id
    const cards = new Set();
    const add = (c) => { if (c?.id) cards.add(c.id); };
    for (const c of featured.body.collated ?? []) add(c);
    for (const c of featured.body.books ?? []) add(c);
    for (const node of tree.body) {
        // 节点共 ceil(count / 每页条数) 页：随机挑至多 perNode 个不同的页，每页抽几张，凑够 perNode 张；
        // 页数多时也只拉这几页，不一次拉几百页
        const pageCount = Math.max(1, Math.ceil((Number(node.count) || 0) / pageSize));
        const pages = pickSome(Array.from({ length: pageCount }, (_, i) => i + 1), perNode, rand);
        const perPage = Math.ceil(perNode / pages.length);
        for (const n of pages) {
            const page = await json(`read/${node.id}/${n}.json`);
            if (!page.ok || !Array.isArray(page.body)) { fail(`read/${node.id}/${n}.json`, '数据', page.ok ? '不是数组' : `→ ${why(page)}`); continue; }
            for (const c of pickSome(page.body, perPage, rand)) add(c);
        }
    }

    const pagePathOf = (id, key) => (key === 'default' ? `/read/${id}` : `/read/${id}/${key}`);

    // 阅读页不列的版本（overview#456）：作品有 kind=transcription 全文版时，kind=collated 的整理本阅读页不开（404），数据仍在
    const hiddenInReader = (versions, v) => v?.kind === 'collated' && versions.some((x) => x?.kind === 'transcription');

    // 新结构条目：manifest.versions 逐份核对目录、首章与页面
    async function checkNewCard(id, manifest) {
        const versions = Array.isArray(manifest?.versions) ? manifest.versions : [];
        if (versions.length === 0) { fail(id, '数据', `items/${id}/manifest.json 没有 versions`); return; }
        if (isInternal(manifest) || versions.some(isInternal)) fail(id, '数据', `items/${id}/manifest.json 带 visibility=internal，私有文本进了公开产物`);
        // 有 default 就必须排第一；只有原貌（original）等、还没有整理本的书可以没有 default，阅读页按 versions[0] 打开
        if (versions.some((v) => v?.key === 'default') && versions[0]?.key !== 'default') fail(id, '数据', `items/${id}/manifest.json 的 versions[0] 不是 default`);
        for (const v of versions) {
            if (!isTextKey(v?.key)) { fail(id, '数据', `items/${id}/manifest.json 有不合法的版本 key：${JSON.stringify(v?.key)}`); continue; }
            const pagePath = pagePathOf(id, v.key);
            const page = hiddenInReader(versions, v) ? { ok: true } : await getPage(`${site}${pagePath}`);
            if (!page.ok) fail(id, '阅读页', `${site}${pagePath} → ${why(page)}`);
            const base = `items/${id}/${v.key}`;
            const idx = await json(`${base}/index.json`);
            if (!idx.ok) { fail(id, '数据', `${base}/index.json → ${why(idx)}`); continue; }
            const first = firstChapterOf(idx.body);
            if (!first) { fail(id, '数据', `${base}/index.json 的 chapters 为空`); continue; }
            // has_json 的章可以没有 md（只有结构化 json）；其余章 md 必须在
            // 对读章（自校本）真源是 char.json，不产 md／txt：声明了 char_file 就查它
            if (first.charFile) {
                const cf = await getData(`${cur}/${base}/${first.charFile}?${bust}`, false);
                if (!cf.ok) fail(id, '数据', `${base}/${first.charFile} → ${why(cf)}`);
            } else if (!first.hasJson) {
                const ch = await getData(`${cur}/${base}/${chapterTxtFile(first.file)}?${bust}`, false);
                if (!ch.ok) fail(id, '数据', `${base}/${chapterTxtFile(first.file)} → ${why(ch)}`);
            }
            if (first.hasJson && !first.charFile) {
                const cj = await getData(`${cur}/${base}/${first.file.replace(/\.(md|txt)$/, '')}.json?${bust}`, false);
                if (!cj.ok) fail(id, '数据', `${base}/${first.file.replace(/\.(md|txt)$/, '')}.json → ${why(cj)}`);
            }
        }
    }

    /** 并发 n 个 worker 跑完 items，单项抛错交给 onError */
    async function pool(items, n, fn, onError) {
        const queue = [...items];
        await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => {
            for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
                try { await fn(next); } catch (e) { onError?.(next, e); }
            }
        }));
    }

    // ① 先取每张卡的 manifest（阅读首页的卡片必须有；404 / 5xx / 网络错误 / JSON 坏都记失败），据此算出要查的阅读页
    const manifests = new Map();
    await pool(cards, concurrency, async (id) => {
        const manifest = await json(`items/${id}/manifest.json`);
        if (!manifest.ok) { fail(id, '数据', `items/${id}/manifest.json → ${why(manifest)}`); return; }
        manifests.set(id, manifest.body);
    }, (id, e) => fail(id, '请求', e.message));

    // ② 预热：这次要查的阅读页低并发 GET 一遍，不计成败（新部署后首次渲染慢，overview#322），记首次状态与耗时
    let warmStats = null;
    if (warm) {
        const urls = [];
        for (const [id, m] of manifests) {
            const vs = Array.isArray(m?.versions) ? m.versions : [];
            for (const v of vs) {
                if (isTextKey(v?.key) && !hiddenInReader(vs, v)) urls.push(`${site}${pagePathOf(id, v.key)}`);
            }
        }
        warmStats = { pages: urls.length, notOk: [], ms: [] };
        await pool(urls, warmConcurrency, async (url) => {
            const t0 = Date.now();
            const r = await get(url, false, warmTimeoutMs);
            warmStats.ms.push(Date.now() - t0);
            if (!r.ok) warmStats.notOk.push({ url, status: r.status });
        });
    }

    // ③ 正式抽检
    await pool([...manifests.keys()], concurrency, (id) => checkNewCard(id, manifests.get(id)), (id, e) => fail(id, '请求', e.message));
    return { checked: cards.size, pagesChecked, failures, retried, retriedData, warm: warmStats };
}

/** 重试后通过的阅读页占比是否超过告警线（只告警，不拦发布） */
export function retryWarning({ pagesChecked = 0, retried = [] }, warnRatio = 0.2) {
    const ratio = pagesChecked ? retried.length / pagesChecked : 0;
    return { ratio, warn: ratio > warnRatio };
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const sec = (ms) => `${(ms / 1000).toFixed(1)} s`;

export function renderSummary({ checked, pagesChecked = 0, failures, retried = [], retriedData = [], warm = null }, { target, seed, warnRatio = 0.2 }) {
    const lines = [`## 阅读链接抽检（${target}）`, '', `抽检 ${checked} 张卡、${pagesChecked} 个阅读页，失败 ${failures.length} 处（seed=${seed}）。`];
    if (warm) {
        lines.push('', `预热：${warm.pages} 个阅读页，首次请求非 200 的 ${warm.notOk.length} 个（${pct(warm.pages ? warm.notOk.length / warm.pages : 0)}）；`
            + `首次耗时 p50 ${sec(percentile(warm.ms, 50))}、p90 ${sec(percentile(warm.ms, 90))}、最长 ${sec(percentile(warm.ms, 100))}（预热结果不计成败，是冷启动的实测，overview#322）。`);
        const byStatus = {};
        for (const n of warm.notOk) byStatus[n.status || '连接失败'] = (byStatus[n.status || '连接失败'] ?? 0) + 1;
        if (warm.notOk.length) lines.push(`预热非 200 按状态：${Object.entries(byStatus).map(([k, v]) => `${k}×${v}`).join('、')}`);
    }
    const { ratio, warn } = retryWarning({ pagesChecked, retried }, warnRatio);
    if (retried.length) {
        lines.push('', `阅读页 503／522／524／525／连接失败、重试后通过 ${retried.length} 处，占抽检阅读页 ${pct(ratio)}（不记失败；说明首次渲染仍超回源时限，overview#322）：`);
        for (const u of retried.slice(0, 20)) lines.push(`- ${u}`);
    }
    if (retriedData.length) {
        lines.push('', `数据文件 503／522／524／525／连接失败、重试后通过 ${retriedData.length} 处（不记失败）：`);
        for (const u of retriedData.slice(0, 20)) lines.push(`- ${u}`);
    }
    if (warn) lines.push('', `⚠️ 重试后通过的占比 ${pct(ratio)} 超过 ${pct(warnRatio)}：只告警，不拦发布。阅读页冷启动明显变慢了，请看 overview#322。`);
    if (failures.length) {
        lines.push('', '| 条目 | 项 | 详情 |', '|---|---|---|');
        for (const f of failures.slice(0, 50)) lines.push(`| ${f.id} | ${f.what} | ${f.detail} |`);
        if (failures.length > 50) lines.push('', `…还有 ${failures.length - 50} 处`);
    }
    return lines.join('\n');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
    const { parseArgs } = await import('node:util');
    const { values: a } = parseArgs({ options: { target: { type: 'string' }, data: { type: 'string' }, 'per-node': { type: 'string' }, seed: { type: 'string' } } });
    const target = a.target ?? process.env.TARGET;
    const dataBase = a.data ?? process.env.DATA_BASE;
    if (!target || !dataBase) {
        console.error('缺 --target／TARGET 或 --data／DATA_BASE');
        process.exit(2);
    }
    // DATA_BASE 形如 https://data.kaiyuanguji.com 或 …/staging；current/ 在其下
    const seed = a.seed ? Number(a.seed) : Date.now() % 2 ** 31;
    let res;
    try {
        res = await checkReadLinks({ target, dataBase, perNode: a['per-node'] ? Number(a['per-node']) : 20, seed });
    } catch (e) {
        // 兜底：意料之外的异常也要出报告再退出
        res = { checked: 0, pagesChecked: 0, failures: [{ id: '-', what: '检查脚本', detail: e.message }], retried: [], retriedData: [], warm: null };
    }
    const md = renderSummary(res, { target, seed });
    console.log(md);
    const { ratio, warn } = retryWarning(res);
    if (warn) console.log(`::warning title=阅读页冷启动::重试后才通过的阅读页占 ${(ratio * 100).toFixed(1)}%（>20%），不拦发布，见 job summary 与 overview#322`);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
    process.exit(res.failures.length ? 1 : 0);
}
