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
 * 可读＝**站内真有正文**（overview#306）。不看 has_text——那是「resources 里有外部文本资源」，与站内有没有正文无关，
 *       曾让阅读首页 55.9% 的卡片点进去是 404。判据与阅读页 404 判定（lib/server/reader-check.ts）同源：
 *   Work：整理本 collated_edition/index.json 的 juan_files 非空，
 *         或 book-text/index/full_text 里有非 Book 所有、total_chapters>0 的条目；
 *   Book：full_text/index.json 存在且 chapters 非空。
 * 构建期再逐卡核对产物里的目录与首章／首卷文件在不在（bundleRead 的 verifyItems），缺则构建失败。
 *
 * ReadCard { id, title, edition?, juan?, authors?: {name, dynasty?}[], collated?: true, classification?: string[] }
 *
 * 用法：bundle-data.mjs 在总目之后调用 bundleRead()（正常流程）；
 *       node scripts/build-read-index.mjs [draftDir]   单独重建
 */
import { existsSync, readFileSync, readdirSync } from 'fs';
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

/** 读一个 JSON，不存在或读不了返回 null */
function readJsonOrNull(p) {
    try {
        return JSON.parse(readFileSync(p, 'utf-8'));
    } catch {
        return null;
    }
}

/** 整理本：collated_edition/index.json 有非空 juan_files。返回首卷文件名，不可读返回 null */
export function collatedFirstJuan(itemDir) {
    const idx = readJsonOrNull(join(itemDir, 'collated_edition', 'index.json'));
    const files = Array.isArray(idx?.juan_files) ? idx.juan_files.filter((f) => typeof f === 'string' && f) : [];
    return files.length ? files[0] : null;
}

/**
 * Work 全文：index/full_text 分片里该 Work 的条目（已排好序，首项 primary）。
 * 只认非 Book 所有、有 key 且 total_chapters>0 的；返回阅读页会选的那一个（primary 优先，否则第一个），没有返回 null。
 */
export function workFullTextPick(list) {
    const ok = (Array.isArray(list) ? list : []).filter((v) => v && v.owner_type !== 'Book' && typeof v.key === 'string' && v.total_chapters > 0);
    return ok.find((v) => v.primary) ?? ok[0] ?? null;
}

/** Book 全文：full_text/index.json 有非空 chapters。返回首章文件名，不可读返回 null */
export function bookFirstChapter(itemDir) {
    const idx = readJsonOrNull(join(itemDir, 'full_text', 'index.json'));
    const ch = Array.isArray(idx?.chapters) ? idx.chapters.find((c) => typeof c?.file === 'string' && c.file) : null;
    return ch ? ch.file : null;
}

/** 读 book-text/index/full_text/*.json 合并成 { workId: entry[] } */
export function loadWorkFullTextLists(textDir) {
    const all = new Map();
    const dir = join(textDir, 'index', 'full_text');
    if (!existsSync(dir)) return all;
    for (const f of readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        const data = readJsonOrNull(join(dir, f));
        if (data && typeof data === 'object') for (const [id, list] of Object.entries(data)) all.set(id, list);
    }
    return all;
}

/** 卡片：总目卡片去掉提要，加整理本标记 */
export function toReadCard(d, collated) {
    const c = toCard(d);
    delete c.summary;
    // 版本名（Book 的 edition）：同名书（《钦定四库全书总目》《脂砚斋重评石头记》等）靠它在卡片上分辨
    if (typeof d.edition === 'string' && d.edition.trim()) c.edition = d.edition.trim();
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
 *   textDirFor: (e: any) => string, dataDir: string, taxonomyFile?: string, verifyItems?: boolean,
 *   log?: (s: string) => void }} args
 * textDirFor：条目 → 文本仓根目录（整理本／全文都在那里，不在元数据仓）。
 * verifyItems：true 时构建后逐卡核对 dataDir/items/ 下的目录与首章／首卷文件，缺则抛错（bundle-data 开）。
 */
export function bundleRead({ index, rootDirFor, textDirFor, dataDir, taxonomyFile, verifyItems = false, log = console.log }) {
    const rank = taxonomyFile && existsSync(taxonomyFile)
        ? taxonomyRank(JSON.parse(readFileSync(taxonomyFile, 'utf-8')))
        : new Map();
    let merged = 0;
    const fullTexts = loadWorkFullTextLists(textDirFor({}));
    /** 构建期核对清单：{ id, kind: 'collated'|'fulltext'|'book', key?, first } */
    const probes = [];

    function* works() {
        for (const item of Object.values(index.works ?? {})) {
            const p = join(rootDirFor(item), item.path);
            if (!existsSync(p)) continue;
            const d = readJsonSafe(p, log, item.path);
            if (!d || d.merged_into) { if (d) merged++; continue; }
            if (!d.id) d.id = item.id;
            const itemDir = join(textDirFor(item), dirname(item.path), d.id);
            const juan = collatedFirstJuan(itemDir);
            const pick = workFullTextPick(fullTexts.get(d.id));
            if (!juan && !pick) continue;
            if (juan) probes.push({ id: d.id, kind: 'collated', first: juan });
            if (pick) probes.push({ id: d.id, kind: 'fulltext', key: pick.key });
            yield { d, card: toReadCard(d, !!juan) };
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
        const first = bookFirstChapter(join(textDirFor(item), dirname(item.path), d.id));
        if (!first) continue;
        probes.push({ id: d.id, kind: 'book', first });
        books.push(toReadCard(d, false));
    }
    books.sort(compareReadCards);

    const w = writeCatalog(dataDir, built, {
        dirName: 'read',
        pageSize: READ_PAGE_SIZE,
        extra: { 'featured.json': { collated: collatedUnique, books } },
    });
    if (verifyItems) {
        const missing = verifyReadProbes(probes, dataDir);
        if (missing.length) {
            const head = missing.slice(0, 30).map((m) => `  - ${m}`).join('\n');
            throw new Error(`read/ 有 ${missing.length} 处阅读卡片对应的数据文件在产物里缺失（overview#306）：\n${head}${missing.length > 30 ? '\n  …' : ''}`);
        }
        log(`    核对 ${probes.length} 项阅读入口的数据文件：全部在产物里`);
    }
    log(`READ read/: 可读 Work ${built.stats.total}（有分类 ${built.stats.classified}，未分類 ${built.stats.unclassified}；跳过被并 ${merged}），整理本 ${collatedUnique.length}，Book 全文 ${books.length}`);
    log(`    ${built.lists.size} 个节点，${w.files} 个文件（${(w.bytes / 1024 / 1024).toFixed(1)} MB），删旧 ${w.removed}`);
    return { ...built, collated: collatedUnique, books, written: w };
}

/**
 * 构建期核对：每张阅读卡对应的目录与首章／首卷文件，在产物 dataDir/items/<id>/ 下都存在（.md 已改名 .txt）。
 * 返回缺失清单（空＝全部在）。
 */
export function verifyReadProbes(probes, dataDir) {
    const missing = [];
    const need = (id, rel) => {
        if (!existsSync(join(dataDir, 'items', id, rel))) missing.push(`${id}: items/${id}/${rel}`);
    };
    const txt = (f) => (f.endsWith('.md') ? `${f.slice(0, -3)}.txt` : f);
    for (const p of probes) {
        if (p.kind === 'collated') {
            need(p.id, 'collated_edition/index.json');
            need(p.id, `collated_edition/${p.first}`);
        } else if (p.kind === 'fulltext') {
            const idxPath = join(dataDir, 'items', p.id, 'full_text', p.key, 'index.json');
            if (!existsSync(idxPath)) { missing.push(`${p.id}: items/${p.id}/full_text/${p.key}/index.json`); continue; }
            const first = bookFirstChapterOfIndex(readJsonOrNull(idxPath));
            if (!first) missing.push(`${p.id}: items/${p.id}/full_text/${p.key}/index.json 的 chapters 为空`);
            else need(p.id, `full_text/${p.key}/${txt(first)}`);
        } else {
            need(p.id, 'full_text/index.json');
            need(p.id, `full_text/${txt(p.first)}`);
        }
    }
    return missing;
}

function bookFirstChapterOfIndex(idx) {
    const ch = Array.isArray(idx?.chapters) ? idx.chapters.find((c) => typeof c?.file === 'string' && c.file) : null;
    return ch ? ch.file : null;
}

// ─── 单独运行 ───

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    const { resolveDataDirs } = await import('./lib/data-dirs.mjs');
    const here = dirname(fileURLToPath(import.meta.url));
    const draftDir = resolve(process.argv[2] || process.env.BOOK_INDEX_DRAFT_DIR || join(here, '..', '..', 'book-index-draft'));
    const prodDir = resolve(process.env.BOOK_INDEX_PRODUCTION_DIR || join(here, '..', '..', 'book-index'));
    const textDir = resolve(process.env.BOOK_TEXT_DIR || join(here, '..', '..', 'book-text'));
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
        textDirFor: () => textDir,
        dataDir: resolveDataDirs().dataDir,
        taxonomyFile: join(prodDir, 'classific.json'),
    });
}
