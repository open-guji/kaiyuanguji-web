#!/usr/bin/env node
/**
 * build-catalog-index.mjs — 古籍总目的构建期分类索引（N4b，overview#219）
 *
 * 从每部 Work 的分类（新：build 产物 `_classifications[]`；回退旧 `classification` {l1,l2,l3,l4,basis,source}，见 lib/derived.mjs）生成：
 *   catalog/tree.json                 CatalogNode[]：经史子集分类树，每个节点带计数（含子孙），
 *                                     「未分類」单独一个节点放在最后
 *   catalog/<nodeId>/<page>.json      CatalogWorkCard[]：该节点（含子孙）下的作品，每页 20 条，
 *                                     有提要的在前，再按书名（拼音序）；page 从 1 起
 *
 * 数据契约与 book-index-manager 的总目组件（N4a，overview#218 第 4 条）共用：
 *   CatalogNode     { id, label, count, children? }
 *   CatalogWorkCard { id, title, juan?, authors?: {name, dynasty?}[], summary?, classification?: string[] }
 * 字段要改先在两张卡上互相通知。
 *
 * 文件放在现有数据目录（resolveDataDirs().dataDir）下，随 sync-to-cos.mjs 进 current/catalog/，
 * 前端带 ?v=<cacheKey> 读；不另开存储。节点页数由 tree.json 的 count 推出，不另写清单。
 *
 * 节点 id：分类路径（如「史部/紀傳類」）的 sha1 前 10 位，前缀 c——只要分类名不变就稳定，
 * 地址里不出现中文。没有 l1 的作品归顶层「未分類」，id 固定为 `unclassified`；
 * 部、类下的「未分類」（如「史部/未分類」）是普通节点，按路径算 id，放在同级最后。
 * 同名的类（如經、史、子三部各有「總類」）按完整路径区分，不会混。
 * 类名一律来自数据与分类表（book-index 的 classific.json），本脚本不写死任何类名。
 *
 * 用法：
 *   bundle-data.mjs 在 L1 之后调用 bundleCatalog()（正常流程）
 *   node scripts/build-catalog-index.mjs [bookIndexDir]   单独重建（目录解析与 bundle-data 相同）
 */

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'fs';
import { classificationOf, indexDirFor, readEntryDoc, reportEntryReads, taxonomyFileFor } from './lib/derived.mjs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

export const CATALOG_PAGE_SIZE = 20;
export const UNCLASSIFIED_ID = 'unclassified';
export const UNCLASSIFIED_LABEL = '未分類';
/** 卡片提要截断长度（字）。组件只显示三行，整段放进去白占体积 */
export const SUMMARY_MAX = 120;
/** 卡片最多带几位作者 */
const AUTHORS_MAX = 3;
/**
 * 部的次序：优先按分类表（classific.json 的出现次序）；分类表缺部时退回这张表。
 * 2026-09-30 起分类表改用《中国古籍总目》（overview#292）：五部，多了「叢書部」。
 * 叢書部目前没有 Work（丛书是 Collection），树按作品生成，空部自然不出现。
 */
const TOP_ORDER = ['經部', '史部', '子部', '集部', '叢書部'];
const LEVELS = ['l1', 'l2', 'l3', 'l4'];

/** 分类路径 → 节点 id */
export function nodeIdFor(path) {
    return 'c' + createHash('sha1').update(path.join('/')).digest('hex').slice(0, 10);
}

/** classification 对象 → 路径（l1 起连续非空的几级）；没有 l1 返回 [] */
export function classificationPath(cls) {
    if (!cls || typeof cls !== 'object') return [];
    const out = [];
    for (const k of LEVELS) {
        const v = typeof cls[k] === 'string' ? cls[k].trim() : '';
        if (!v) break;
        out.push(v);
    }
    return out;
}

function descriptionText(d) {
    const desc = d.description;
    const text = typeof desc === 'string' ? desc : desc && typeof desc.text === 'string' ? desc.text : '';
    return text.trim();
}

function truncate(s, n) {
    const chars = Array.from(s);
    return chars.length > n ? chars.slice(0, n).join('') + '…' : s;
}

/** Work 详情 → CatalogWorkCard（只留卡片要显示的字段） */
export function toCard(d) {
    const card = { id: d.id, title: d.title || d.primary_name || d.id };
    if (typeof d.juan_count === 'number' && d.juan_count > 0) card.juan = d.juan_count;
    if (Array.isArray(d.authors)) {
        const authors = [];
        for (const a of d.authors) {
            if (!a || typeof a.name !== 'string' || !a.name.trim()) continue;
            const au = { name: a.name.trim() };
            // 作者本身多半不带朝代；第一作者借用作品的 dynasty（注疏者常晚于原作者，故只给第一位）
            const dynasty = a.dynasty || (authors.length === 0 ? d.dynasty : undefined);
            if (typeof dynasty === 'string' && dynasty.trim()) au.dynasty = dynasty.trim();
            authors.push(au);
            if (authors.length >= AUTHORS_MAX) break;
        }
        if (authors.length) card.authors = authors;
    }
    const summary = descriptionText(d);
    if (summary) card.summary = truncate(summary, SUMMARY_MAX);
    const path = classificationPath(classificationOf(d));
    if (path.length) card.classification = path;
    return card;
}

// 书名按汉语拼音（zh）排；zh-Hant 默认是笔画序，对简体界面的读者不直观
const collator = new Intl.Collator('zh');

/**
 * 书名的排序键：去掉开头的标点与括注（如「(开庆)四明续志」「《妙法蓮華經》…」「@言」），
 * 否则这类书名会整批排到拼音序最前面。括注整段去掉，只剩书名本身。
 */
export function titleSortKey(title) {
    let t = String(title ?? '').trim();
    for (let i = 0; i < 4; i++) {
        const next = t
            .replace(/^[(（〔［\[【][^)）〕］\]】]{0,12}[)）〕］\]】]/u, '')
            .replace(/^[^\p{L}\p{N}]+/u, '');
        if (next === t) break;
        t = next;
    }
    return t || String(title ?? '');
}

/** 有提要优先，再按书名拼音（overview#229 定），最后按 id（保证输出稳定） */
export function compareCards(a, b) {
    const sa = a.summary ? 0 : 1;
    const sb = b.summary ? 0 : 1;
    if (sa !== sb) return sa - sb;
    const t = collator.compare(titleSortKey(a.title), titleSortKey(b.title));
    if (t !== 0) return t;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 分类表（book-index 的 classific.json）→ 各路径的先后次序 */
export function taxonomyRank(list) {
    const rank = new Map();
    if (!Array.isArray(list)) return rank;
    for (const row of list) {
        const path = [];
        for (const k of ['cata_l1', 'cata_l2', 'cata_l3', 'cata_l4']) {
            if (!row?.[k]) break;
            path.push(row[k]);
            const key = path.join('/');
            if (!rank.has(key)) rank.set(key, rank.size);
        }
    }
    return rank;
}

/**
 * 构建分类树与各节点的作品清单。
 * @param {Iterable<object>} works Work 详情（已去掉被并条目）
 * @param {{ rank?: Map<string, number> }} [opts]
 * @returns {{ tree: object[], lists: Map<string, object[]>, stats: object }}
 */
export function buildCatalog(works, opts = {}) {
    const rank = opts.rank ?? new Map();
    // 阅读首页索引（build-read-index.mjs）与总目共用分类树与节点 id，只换卡片形态与排序
    const makeCard = opts.toCard ?? toCard;
    const compare = opts.compare ?? compareCards;
    // 内部节点：{ id, label, key, cards: [], children: Map }
    const roots = new Map();
    const unclassified = { id: UNCLASSIFIED_ID, label: UNCLASSIFIED_LABEL, key: '', cards: [], children: new Map() };
    const stats = { total: 0, classified: 0, unclassified: 0, byTop: {} };

    for (const d of works) {
        const card = makeCard(d);
        stats.total++;
        const path = card.classification ?? [];
        if (!path.length) {
            stats.unclassified++;
            unclassified.cards.push(card);
            continue;
        }
        stats.classified++;
        stats.byTop[path[0]] = (stats.byTop[path[0]] ?? 0) + 1;
        let level = roots;
        for (let i = 0; i < path.length; i++) {
            const sub = path.slice(0, i + 1);
            let node = level.get(path[i]);
            if (!node) {
                node = { id: nodeIdFor(sub), label: path[i], key: sub.join('/'), cards: [], children: new Map() };
                level.set(path[i], node);
            }
            node.cards.push(card);
            level = node.children;
        }
    }

    const lists = new Map();
    const topRank = (label) => {
        const i = TOP_ORDER.indexOf(label);
        return i === -1 ? TOP_ORDER.length : i;
    };
    const sortSiblings = (nodes, isTop) => nodes.sort((a, b) => {
        // 部、类、属各级的「未分類」（总目词表里每部、每类都有，且排在该级最前）一律放到同级最后
        const ua = a.label === UNCLASSIFIED_LABEL ? 1 : 0;
        const ub = b.label === UNCLASSIFIED_LABEL ? 1 : 0;
        if (ua !== ub) return ua - ub;
        // 部：两部都在分类表里才按分类表比，否则按内置次序（分类表不全时也保证经史子集叢）
        if (isTop && !(rank.has(a.key) && rank.has(b.key))) {
            const r = topRank(a.label) - topRank(b.label);
            if (r !== 0) return r;
        }
        const ra = rank.get(a.key) ?? Infinity;
        const rb = rank.get(b.key) ?? Infinity;
        if (ra !== rb) return ra - rb;
        if (a.cards.length !== b.cards.length) return b.cards.length - a.cards.length;
        return collator.compare(a.label, b.label);
    });
    const finish = (node, isTop) => {
        lists.set(node.id, node.cards.sort(compare));
        const out = { id: node.id, label: node.label, count: node.cards.length };
        if (node.children.size) {
            out.children = sortSiblings([...node.children.values()], false).map((c) => finish(c, false));
        }
        return out;
    };
    const tree = sortSiblings([...roots.values()], true).map((n) => finish(n, true));
    if (unclassified.cards.length) tree.push(finish(unclassified, false));
    return { tree, lists, stats };
}

export function pageCountOf(count) {
    return Math.max(1, Math.ceil(count / CATALOG_PAGE_SIZE));
}

function writeIfChanged(path, text) {
    const buf = Buffer.from(text, 'utf-8');
    if (existsSync(path)) {
        const old = readFileSync(path);
        if (old.length === buf.length && old.equals(buf)) return buf.length;
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, buf);
    return buf.length;
}

/**
 * 写出 catalog/ 目录。内容不变的文件不动 mtime（sync-to-cos 的缓存据此跳过），
 * 这一版不再有的文件删掉（sync-to-cos 随后从 COS 清孤儿）。
 * @returns {{ files: number, bytes: number, removed: number }}
 */
export function writeCatalog(dataDir, built, opts = {}) {
    const dirName = opts.dirName ?? 'catalog';
    const pageSize = opts.pageSize ?? CATALOG_PAGE_SIZE;
    const dir = join(dataDir, dirName);
    mkdirSync(dir, { recursive: true });
    const keep = new Set();
    let bytes = 0;
    const put = (rel, data) => {
        keep.add(rel);
        bytes += writeIfChanged(join(dir, rel), JSON.stringify(data));
    };
    put('tree.json', built.tree);
    // 额外的整文件（如阅读首页的精选清单）
    for (const [rel, data] of Object.entries(opts.extra ?? {})) put(rel, data);
    for (const [id, cards] of built.lists) {
        const pages = Math.max(1, Math.ceil(cards.length / pageSize));
        for (let p = 1; p <= pages; p++) {
            put(`${id}/${p}.json`, cards.slice((p - 1) * pageSize, p * pageSize));
        }
    }
    let removed = 0;
    const sweep = (abs, rel) => {
        for (const name of readdirSync(abs, { withFileTypes: true })) {
            const r = rel ? `${rel}/${name.name}` : name.name;
            const a = join(abs, name.name);
            if (name.isDirectory()) {
                sweep(a, r);
                if (readdirSync(a).length === 0) rmdirSync(a);
            } else if (!keep.has(r)) {
                rmSync(a);
                removed++;
            }
        }
    };
    sweep(dir, '');
    return { files: keep.size, bytes, removed };
}

/**
 * bundle-data.mjs 的入口：读合并后的分片索引里每部 Work 的详情，建树写盘。
 * @param {{ index: { works: Record<string, any> }, rootDirFor: (e: any) => string, dataDir: string, taxonomyFile?: string, log?: (s: string) => void }} args
 */
export function bundleCatalog({ index, rootDirFor, dataDir, taxonomyFile, log = console.log }) {
    const rank = taxonomyFile && existsSync(taxonomyFile)
        ? taxonomyRank(JSON.parse(readFileSync(taxonomyFile, 'utf-8')))
        : new Map();
    const perRoot = {};
    let merged = 0;
    function* works() {
        for (const item of Object.values(index.works ?? {})) {
            // schema-v2：优先读 build 产物 entry/<id>.json（带 _classifications），缺则读源档（lib/derived.mjs）
            let d;
            try {
                d = readEntryDoc({ id: item.id, srcPath: join(rootDirFor(item), item.path), stat: 'catalog' })?.doc;
                if (!d) continue;
            } catch (e) {
                log(`  ⚠ catalog: 读不了 ${item.path}: ${e.message}`);
                continue;
            }
            // 被并条目：页面会 308 到目标，总目里不再列
            if (d.merged_into) { merged++; continue; }
            if (!d.id) d.id = item.id;
            const root = item._root ?? 'official';
            const r = (perRoot[root] ??= { classified: 0, unclassified: 0 });
            if (classificationPath(classificationOf(d)).length) r.classified++; else r.unclassified++;
            yield d;
        }
    }
    const built = buildCatalog(works(), { rank });
    const w = writeCatalog(dataDir, built);
    const { stats } = built;
    const tops = Object.entries(stats.byTop).map(([k, v]) => `${k} ${v}`).join('，');
    log(`CAT catalog/: ${stats.total} works（有分类 ${stats.classified}，未分類 ${stats.unclassified}；跳过被并 ${merged}）`);
    log(`    各部：${tops}`);
    for (const [root, r] of Object.entries(perRoot)) log(`    ${root}: 有分类 ${r.classified}，无 ${r.unclassified}`);
    log(`    ${built.lists.size} 个节点，${w.files} 个文件（${(w.bytes / 1024 / 1024).toFixed(1)} MB），删旧 ${w.removed}`);
    return { ...built, written: w, perRoot, merged };
}

// ─── 单独运行 ───

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    const { resolveDataDirs } = await import('./lib/data-dirs.mjs');
    const here = dirname(fileURLToPath(import.meta.url));
    const prodDir = resolve(process.argv[2] || process.env.BOOK_INDEX_PRODUCTION_DIR || join(here, '..', '..', 'book-index'));
    const { assertProductionDir } = await import('./lib/production-dir.mjs');
    try { assertProductionDir(prodDir); } catch (e) { console.error(`❌ ${e.message}`); process.exit(1); }
    const index = { works: {} };
    for (const [dir, label] of [[prodDir, 'official']]) {
        const shardDir = join(indexDirFor(dir), 'works');
        if (!existsSync(shardDir)) continue;
        for (let i = 0; i < 16; i++) {
            const p = join(shardDir, `${i.toString(16)}.json`);
            if (!existsSync(p)) continue;
            for (const [id, e] of Object.entries(JSON.parse(readFileSync(p, 'utf-8')))) {
                if (e?.promoted_to) continue;
                index.works[id] = { ...e, _root: label };
            }
        }
    }
    bundleCatalog({
        index,
        rootDirFor: () => prodDir,
        dataDir: resolveDataDirs().dataDir,
        taxonomyFile: taxonomyFileFor(prodDir),
    });
    if (reportEntryReads().fail) process.exit(1);
}
