#!/usr/bin/env node
/**
 * read-links-check.mjs — 部署后抽检：阅读首页（/read）列出的卡片，点进去真能读（overview#306）
 *
 * 背景：阅读索引曾把「有外部文本链接」当成「站内有全文」，首页 55.9% 的卡片点开是 404。
 * 构建期已逐卡核对产物（nextjs/scripts/build-read-index.mjs 的 verifyItems），这里是上线后的外部复核：
 *   read/tree.json 的每个一级节点随机抽 N 张（默认 20；先随机挑页、再从页里抽，不只看第 1 页）
 *   ＋ read/featured.json（整理本、Book 全文）全部；
 *   每张卡：① /read/<id>?kind=… 页面 200；② 数据里目录（index）与首章／首卷文件都 200。
 *   数据路径与阅读页同源（nextjs/src/lib/server/reader-check.ts）：
 *     整理本  items/<id>/collated_edition/index.json → juan_files[0]
 *     Work 全文  index/full_text/<分片>.json → 首选条目 key → items/<id>/full_text/<key>/index.json → chapters[0].file（.md→.txt）
 *     Book 全文  items/<id>/full_text/index.json → chapters[0].file
 *
 * 只发 GET，无依赖、无 secret。CLI：
 *   node ops/read-links-check.mjs --target https://www.kaiyuanguji.com --data https://data.kaiyuanguji.com [--per-node 20] [--seed 1]
 * 环境变量 TARGET／DATA_BASE 同名（verify.yml 已设）。有失败退出码 1，并在 GitHub Actions 里写 job summary。
 */
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { decodeId, mulberry32 } from './dq-lib.mjs';

/** 与 reader-check.ts／book-index-ui 的 shardOf 同一算法（16 片） */
export function fullTextShardOf(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (Math.imul(h, 31) + id.charCodeAt(i)) >>> 0;
    return (h % 16).toString(16);
}

const txt = (f) => (f.endsWith('.md') ? `${f.slice(0, -3)}.txt` : f);

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
 * @param {{ target: string, dataBase: string, fetchImpl?: typeof fetch, perNode?: number, pageSize?: number, seed?: number, concurrency?: number }} o
 * @returns {Promise<{ checked: number, failures: { id: string, what: string, detail: string }[] }>}
 */
export async function checkReadLinks({ target, dataBase, fetchImpl = fetch, perNode = 20, pageSize = 20, seed = Date.now() % 2 ** 31, concurrency = 6 }) {
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
    const json = async (rel) => get(`${cur}/${rel}?${bust}`, true);

    const failures = [];
    const fail = (id, what, detail) => failures.push({ id, what, detail });

    const tree = await json('read/tree.json');
    const featured = await json('read/featured.json');
    // 顶层清单读不了：记成失败返回（调用方照常渲染、写 summary 再退出），不抛
    if (!tree.ok || !Array.isArray(tree.body)) fail('read/tree.json', '数据', tree.ok ? '不是数组' : `read/tree.json → ${why(tree)}`);
    if (!featured.ok || typeof featured.body !== 'object' || !featured.body) fail('read/featured.json', '数据', featured.ok ? '不是对象' : `read/featured.json → ${why(featured)}`);
    if (failures.length) return { checked: 0, failures };

    // 待查的卡：id → { collated }
    const cards = new Map();
    const add = (c) => { if (c?.id && !cards.has(c.id)) cards.set(c.id, { collated: !!c.collated }); };
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

    async function checkCard(id, { collated }) {
        const isBook = decodeId(id).type === 'book';
        const kind = collated ? 'collated' : 'fulltext';
        const page = await get(`${site}/read/${id}?kind=${kind}`, false);
        if (!page.ok) fail(id, '阅读页', `${site}/read/${id}?kind=${kind} → ${why(page)}`);

        // 数据：目录与首章／首卷
        const need = async (rel, asJson) => {
            const r = await get(`${cur}/${rel}?${bust}`, asJson);
            if (!r.ok) fail(id, '数据', `${rel} → ${why(r)}`);
            return r;
        };
        if (collated) {
            const idx = await need(`items/${id}/collated_edition/index.json`, true);
            const first = idx.ok && Array.isArray(idx.body?.juan_files) ? idx.body.juan_files.find((f) => typeof f === 'string' && f) : null;
            if (idx.ok && !first) fail(id, '数据', `items/${id}/collated_edition/index.json 的 juan_files 为空`);
            else if (first) await need(`items/${id}/collated_edition/${first}`, false);
            return;
        }
        let base;
        if (isBook) {
            base = `items/${id}/full_text`;
        } else {
            const shard = await json(`index/full_text/${fullTextShardOf(id)}.json`);
            if (!shard.ok) { fail(id, '数据', `index/full_text/${fullTextShardOf(id)}.json → ${why(shard)}`); return; }
            const list = (shard.body?.[id] ?? []).filter((v) => v.owner_type !== 'Book' && typeof v.key === 'string');
            const pick = list.find((v) => v.primary) ?? list[0];
            if (!pick) { fail(id, '数据', `index/full_text 里没有 ${id} 的站内全文条目`); return; }
            base = `items/${id}/full_text/${pick.key}`;
        }
        const idx = await need(`${base}/index.json`, true);
        if (!idx.ok) return;
        const first = Array.isArray(idx.body?.chapters) ? idx.body.chapters.find((c) => typeof c?.file === 'string' && c.file) : null;
        if (!first) fail(id, '数据', `${base}/index.json 的 chapters 为空`);
        else await need(`${base}/${txt(first.file)}`, false);
    }

    const queue = [...cards.entries()];
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        for (let next = queue.shift(); next; next = queue.shift()) {
            try {
                await checkCard(next[0], next[1]);
            } catch (e) {
                fail(next[0], '请求', e.message);
            }
        }
    }));
    return { checked: cards.size, failures };
}

export function renderSummary({ checked, failures }, { target, seed }) {
    const lines = [`## 阅读链接抽检（${target}）`, '', `抽检 ${checked} 张卡，失败 ${failures.length} 处（seed=${seed}）。`];
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
        res = { checked: 0, failures: [{ id: '-', what: '检查脚本', detail: e.message }] };
    }
    const md = renderSummary(res, { target, seed });
    console.log(md);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
    process.exit(res.failures.length ? 1 : 0);
}
