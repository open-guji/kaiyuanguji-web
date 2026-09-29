#!/usr/bin/env node
/**
 * build-read-index.mjs — 阅读首页 /read 的构建期「可读条目」索引（overview#267 第 16 项）
 *
 * 与 build-catalog-index.mjs 同一套做法，网站自己在构建时生成、随数据同步到 current/read/，
 * 不在请求时读 Meili（没有 1000 条上限，搜索机挂了阅读首页也能开）：
 *   read/featured.json             { collated: ReadCard[], books: ReadCard[] }
 *                                   整理本的 Work、有全文的 Book，数量少，首页整份列出
 *   read/tree.json                 CatalogNode[]：与古籍总目同一套分类树与节点 id，
 *                                   只计「可读」的 Work（有整理本或有全文），没有可读条目的节点不出现
 *   read/<nodeId>/<page>.json      ReadCard[]：该节点（含子孙）下的可读 Work，每页 20 条，
 *                                   有整理本的在前，再按书名（拼音序）；page 从 1 起
 *
 * 可读：Work 的索引项 has_collated 或 has_text 为 true（详情里同名或 _ 前缀标记也认）；
 *       Book 的索引项 has_text，或 full_text/index.json 存在（has_full_text）。
 *
 * ReadCard { id, title, juan?, authors?: {name, dynasty?}[], collated?: true, classification?: string[] }
 *
 * 用法：bundle-data.mjs 在总目之后调用 bundleRead()（正常流程）；
 *       node scripts/build-read-index.mjs [draftDir]   单独重建
 */
import { existsSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import {
    buildCatalog,
    classificationPath,
    taxonomyRank,
    titleSortKey,
    toCard,
    writeCatalog,
} from './build-catalog-index.mjs';

export const READ_PAGE_SIZE = 20;
const collator = new Intl.Collator('zh');

/** Work 是否可读：索引项或详情里有整理本／全文标记 */
export function workReadable(item, d = {}) {
    return !!(item.has_collated || item.has_text
        || d.has_collated || d._has_collated || d.has_text || d._has_text);
}

export function workCollated(item, d = {}) {
    return !!(item.has_collated || d.has_collated || d._has_collated);
}

/** 卡片：总目卡片去掉提要，加整理本标记 */
export function toReadCard(d, collated) {
    const c = toCard(d);
    delete c.summary;
    if (collated) c.collated = true;
    return c;
}

/** 有整理本在前，再按书名拼音，最后按 id（输出稳定） */
export function compareReadCards(a, b) {
    const ca = a.collated ? 0 : 1;
    const cb = b.collated ? 0 : 1;
    if (ca !== cb) return ca - cb;
    const t = collator.compare(titleSortKey(a.title), titleSortKey(b.title));
    if (t !== 0) return t;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * @param {Iterable<{card: object, d: object}>} works 可读 Work
 * @param {{ rank?: Map<string, number> }} [opts]
 */
export function buildRead(works, opts = {}) {
    const byId = new Map();
    for (const w of works) byId.set(w.d.id, w);
    return buildCatalog([...byId.values()].map((w) => w.d), {
        rank: opts.rank,
        toCard: (d) => byId.get(d.id).card,
        compare: compareReadCards,
    });
}

function readJsonSafe(p, log, what) {
    try {
        return JSON.parse(readFileSync(p, 'utf-8'));
    } catch (e) {
        log(`  ⚠ read: 读不了 ${what}: ${e.message}`);
        return null;
    }
}

/**
 * bundle-data.mjs 的入口。
 * @param {{ index: { works: Record<string, any>, books: Record<string, any> }, rootDirFor: (e: any) => string,
 *   textDirFor?: (e: any) => string, dataDir: string, taxonomyFile?: string, log?: (s: string) => void }} args
 */
export function bundleRead({ index, rootDirFor, textDirFor, dataDir, taxonomyFile, log = console.log }) {
    const rank = taxonomyFile && existsSync(taxonomyFile)
        ? taxonomyRank(JSON.parse(readFileSync(taxonomyFile, 'utf-8')))
        : new Map();
    let merged = 0;

    function* works() {
        for (const item of Object.values(index.works ?? {})) {
            const p = join(rootDirFor(item), item.path);
            if (!existsSync(p)) continue;
            const d = readJsonSafe(p, log, item.path);
            if (!d || d.merged_into) { if (d) merged++; continue; }
            if (!d.id) d.id = item.id;
            if (!workReadable(item, d)) continue;
            yield { d, card: toReadCard(d, workCollated(item, d)) };
        }
    }
    const built = buildRead(works(), { rank });

    const collated = [];
    for (const list of built.lists.values()) for (const c of list) if (c.collated) collated.push(c);
    // 同一部作品会出现在多层节点的清单里，精选清单按 id 去重
    const collatedUnique = [...new Map(collated.map((c) => [c.id, c])).values()].sort(compareReadCards);

    const books = [];
    for (const item of Object.values(index.books ?? {})) {
        const p = join(rootDirFor(item), item.path);
        if (!existsSync(p)) continue;
        const d = readJsonSafe(p, log, item.path);
        if (!d || d.merged_into) continue;
        if (!d.id) d.id = item.id;
        const ftIdx = textDirFor ? join(textDirFor(item), dirname(item.path), item.id, 'full_text', 'index.json') : '';
        if (!(item.has_text || d.has_text || d._has_text || d.has_full_text || (ftIdx && existsSync(ftIdx)))) continue;
        books.push(toReadCard(d, false));
    }
    books.sort(compareReadCards);

    const w = writeCatalog(dataDir, built, {
        dirName: 'read',
        pageSize: READ_PAGE_SIZE,
        extra: { 'featured.json': { collated: collatedUnique, books } },
    });
    log(`READ read/: 可读 Work ${built.stats.total}（有分类 ${built.stats.classified}，未分類 ${built.stats.unclassified}；跳过被并 ${merged}），整理本 ${collatedUnique.length}，Book 全文 ${books.length}`);
    log(`    ${built.lists.size} 个节点，${w.files} 个文件（${(w.bytes / 1024 / 1024).toFixed(1)} MB），删旧 ${w.removed}`);
    return { ...built, collated: collatedUnique, books, written: w };
}

// ─── 单独运行 ───

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    const { resolveDataDirs } = await import('./lib/data-dirs.mjs');
    const here = dirname(fileURLToPath(import.meta.url));
    const draftDir = resolve(process.argv[2] || process.env.BOOK_INDEX_DRAFT_DIR || join(here, '..', '..', 'book-index-draft'));
    const prodDir = resolve(process.env.BOOK_INDEX_PRODUCTION_DIR || join(here, '..', '..', 'book-index'));
    const index = { works: {}, books: {} };
    for (const [dir, label] of [[draftDir, 'draft'], [prodDir, 'official']]) {
        for (const typeKey of ['works', 'books']) {
            const shardDir = join(dir, 'index', typeKey);
            if (!existsSync(shardDir)) continue;
            for (let i = 0; i < 16; i++) {
                const p = join(shardDir, `${i.toString(16)}.json`);
                if (!existsSync(p)) continue;
                for (const [id, e] of Object.entries(JSON.parse(readFileSync(p, 'utf-8')))) {
                    if (e?.promoted_to) continue;
                    index[typeKey][id] = { ...e, _root: label };
                }
            }
        }
    }
    bundleRead({
        index,
        rootDirFor: (e) => (e._root === 'official' ? prodDir : draftDir),
        dataDir: resolveDataDirs().dataDir,
        taxonomyFile: join(prodDir, 'classific.json'),
    });
}
