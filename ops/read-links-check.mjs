#!/usr/bin/env node
/**
 * read-links-check.mjs — 部署后抽检：阅读首页（/read）列出的卡片，点进去真能读（overview#306）
 *
 * 背景：阅读索引曾把「有外部文本链接」当成「站内有全文」，首页 55.9% 的卡片点开是 404。
 * 构建期已逐卡核对产物（nextjs/scripts/build-read-index.mjs 的 verifyItems），这里是上线后的外部复核：
 *   read/tree.json 的每个一级节点随机抽 N 张（默认 20；先随机挑页、再从页里抽，不只看第 1 页）
 *   ＋ read/featured.json（整理本、Book 全文）全部；
 *   每张卡：① /read/<id> 页面（主版本）与 /read/<id>/<key>（其他版本）200；② 数据里目录（index）与首章文件都 200。
 *   页面回 503（EdgeOne 回源超时页，overview#322）先隔 retryDelayMs 重试一次，仍不是 200 才记失败；
 *   重试过才通过的另记在 retried 里写进 summary——它只是兜底，根因在阅读页的首次渲染。
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

/**
 * @param {{ target: string, dataBase: string, fetchImpl?: typeof fetch, perNode?: number, pageSize?: number, seed?: number, concurrency?: number, retryDelayMs?: number }} o
 * @returns {Promise<{ checked: number, failures: { id: string, what: string, detail: string }[], retried: string[] }>}
 */
export async function checkReadLinks({ target, dataBase, fetchImpl = fetch, perNode = 20, pageSize = 20, seed = Date.now() % 2 ** 31, concurrency = 6, retryDelayMs = 3000 }) {
    const cur = `${dataBase.replace(/\/$/, '')}/current`;
    const site = target.replace(/\/$/, '');
    const rand = mulberry32(seed);
    const bust = `t=${Date.now()}`;

    // 网络错误、JSON 解析失败都不抛出，记成 { ok: false }（status 0），由调用方记为失败
    async function get(url, asJson) {
        try {
            const res = await fetchImpl(url, { headers: { 'cache-control': 'no-cache' } });
            if (!res.ok) return { ok: false, status: res.status };
            return { ok: true, status: res.status, body: asJson ? await res.json() : undefined };
        } catch (e) {
            return { ok: false, status: 0, error: e.message };
        }
    }
    const why = (r) => (r.status ? `HTTP ${r.status}` : `请求失败：${r.error}`);
    /**
     * 阅读页：503（EdgeOne 回源超时页）或连接失败（status 0，回源太久被掐断，测试站 10-01 实测）重试一次，
     * 重试通过的记进 retried。404、500 等确定的错误不重试。
     */
    const retried = [];
    async function getPage(url) {
        const first = await get(url, false);
        if (first.status !== 503 && first.status !== 0) return first;
        await new Promise((r) => setTimeout(r, retryDelayMs));
        const second = await get(url, false);
        if (second.ok) retried.push(url);
        return second.ok ? second : { ...second, retriedFrom: first.status === 0 ? '连接失败' : '503' };
    }
    const json = async (rel) => get(`${cur}/${rel}?${bust}`, true);

    const failures = [];
    const fail = (id, what, detail) => failures.push({ id, what, detail });

    const tree = await json('read/tree.json');
    const featured = await json('read/featured.json');
    // 顶层清单读不了：记成失败返回（调用方照常渲染、写 summary 再退出），不抛
    if (!tree.ok || !Array.isArray(tree.body)) fail('read/tree.json', '数据', tree.ok ? '不是数组' : `read/tree.json → ${why(tree)}`);
    if (!featured.ok || typeof featured.body !== 'object' || !featured.body) fail('read/featured.json', '数据', featured.ok ? '不是对象' : `read/featured.json → ${why(featured)}`);
    if (failures.length) return { checked: 0, failures, retried };

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

    // 新结构条目：manifest.versions 逐份核对目录、首章与页面
    async function checkNewCard(id, manifest) {
        const versions = Array.isArray(manifest?.versions) ? manifest.versions : [];
        if (versions.length === 0) { fail(id, '数据', `items/${id}/manifest.json 没有 versions`); return; }
        if (isInternal(manifest) || versions.some(isInternal)) fail(id, '数据', `items/${id}/manifest.json 带 visibility=internal，私有文本进了公开产物`);
        if (versions[0]?.key !== 'default') fail(id, '数据', `items/${id}/manifest.json 的 versions[0] 不是 default`);
        for (const v of versions) {
            if (!isTextKey(v?.key)) { fail(id, '数据', `items/${id}/manifest.json 有不合法的版本 key：${JSON.stringify(v?.key)}`); continue; }
            const pagePath = v.key === 'default' ? `/read/${id}` : `/read/${id}/${v.key}`;
            const page = await getPage(`${site}${pagePath}`);
            if (!page.ok) fail(id, '阅读页', `${site}${pagePath} → ${why(page)}${page.retriedFrom ? `（${page.retriedFrom}后重试一次仍失败）` : ''}`);
            const base = `items/${id}/${v.key}`;
            const idx = await json(`${base}/index.json`);
            if (!idx.ok) { fail(id, '数据', `${base}/index.json → ${why(idx)}`); continue; }
            const first = firstChapterOf(idx.body);
            if (!first) { fail(id, '数据', `${base}/index.json 的 chapters 为空`); continue; }
            // has_json 的章可以没有 md（只有结构化 json）；其余章 md 必须在
            if (!first.hasJson) {
                const ch = await get(`${cur}/${base}/${chapterTxtFile(first.file)}?${bust}`, false);
                if (!ch.ok) fail(id, '数据', `${base}/${chapterTxtFile(first.file)} → ${why(ch)}`);
            }
            if (first.hasJson) {
                const cj = await get(`${cur}/${base}/${first.file.replace(/\.(md|txt)$/, '')}.json?${bust}`, false);
                if (!cj.ok) fail(id, '数据', `${base}/${first.file.replace(/\.(md|txt)$/, '')}.json → ${why(cj)}`);
            }
        }
    }

    async function checkCard(id) {
        // 阅读首页的卡片必须有 manifest.json；只有 404 / 5xx / 网络错误 / JSON 坏都记失败
        const manifest = await json(`items/${id}/manifest.json`);
        if (!manifest.ok) { fail(id, '数据', `items/${id}/manifest.json → ${why(manifest)}`); return; }
        return checkNewCard(id, manifest.body);
    }

    const queue = [...cards];
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        for (let next = queue.shift(); next; next = queue.shift()) {
            try {
                await checkCard(next);
            } catch (e) {
                fail(next, '请求', e.message);
            }
        }
    }));
    return { checked: cards.size, failures, retried };
}

export function renderSummary({ checked, failures, retried = [] }, { target, seed }) {
    const lines = [`## 阅读链接抽检（${target}）`, '', `抽检 ${checked} 张卡，失败 ${failures.length} 处（seed=${seed}）。`];
    if (retried.length) {
        lines.push('', `阅读页首次 503／连接失败、重试后通过 ${retried.length} 处（不记失败，但说明首次渲染仍超回源时限，overview#322）：`);
        for (const u of retried.slice(0, 20)) lines.push(`- ${u}`);
    }
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
        res = { checked: 0, failures: [{ id: '-', what: '检查脚本', detail: e.message }], retried: [] };
    }
    const md = renderSummary(res, { target, seed });
    console.log(md);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
    process.exit(res.failures.length ? 1 : 0);
}
