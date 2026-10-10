#!/usr/bin/env node
/**
 * build-meta-home.mjs — 元数据首页（/book-index 无检索词时，overview#322）的构建期分区数据
 *
 *   meta-home/sections.json   MetaHomeSections（字段见下），浏览器端读（正式站 /book-index 是静态导出）
 *
 * 数据来源（不编数据；缺哪份，对应分区输出空，页面整块隐藏，构建不失败）：
 *   - 合并后的分片索引（works／books／collections／entities）：类型计数、丛编与人物的名字、作品题名
 *   - 作品详情：存佚（loss_status，详情优先、索引条目兜底，与 indexer 同口径）、有无版本谱系（version_graph.enabled）
 *   - book-text 条目目录的 lineage_graph.json：有就算有谱系
 *   - catalog/tree.json（总目，bundleCatalog 先写好）：四部方块
 *   - resource.json（书目著录进度）、resource-site.json（在线资源）：book-index 根目录
 *   - curation/read-home.json 的 shelf 组（layout: 'shelf'，史志书架，period_of／orig）与书目组（key shumu 或 bibliography，同类书目与考证）
 *   - curation/meta-home.json：{ collection_groups, bibliographers, lineage_picks }（目录总管维护）
 *
 * MetaHomeSections {
 *   counts: { works, books, collections, entities },
 *   shelf: { label, items: [{ id, title, authors?, period_of?, orig?, records? }] } | null,   records＝该志的著录条目数
 *   related_catalogs: [{ id, title, authors? }],
 *   catalog_progress: [{ id, name, edition?, total, imported, status, work_id?, collection_id? }],  id 只在索引里查得到时才给
 *   bu, unclassified,                                  同阅读首页（summarizeBu），但计全部作品
 *   collection_groups: [{ key, label, items: [{ id, title }] }],
 *   bibliographers: [{ id, name, dynasty?, birth_year?, death_year? }],
 *   lineage: [{ id, title, authors? }],                只收真有谱系的
 *   sites: [{ id, name, url?, total, imported, status }],
 *   stats: { works, books, collections, entities, has_image, has_text, article, poem,
 *            loss: { extant, partially_extant, lost, unknown } },
 * }
 *
 * 用法：bundle-data.mjs 在总目、阅读索引之后调用 bundleMetaHome()；
 *       node scripts/build-meta-home.mjs [bookIndexDir]   单独重建
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { toCard } from './build-catalog-index.mjs';
import { indexDirFor, readEntryDoc, reportEntryReads } from './lib/derived.mjs';
import { readCuration, summarizeBu } from './build-read-index.mjs';

export const LOSS_KEYS = ['extant', 'partially_extant', 'lost'];

function readJsonOrNull(p) {
    try {
        return JSON.parse(readFileSync(p, 'utf-8'));
    } catch {
        return null;
    }
}

/** 条目详情：schema-v2 的 build 产物优先、缺则读源档（lib/derived.mjs）；没有或读不了返回 null */
function readEntryOrNull(entry, rootDirFor) {
    try {
        return readEntryDoc({ id: entry.id, srcPath: join(rootDirFor(entry), entry.path), stat: 'meta-home' })?.doc ?? null;
    } catch {
        return null;
    }
}

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const arr = (v) => (Array.isArray(v) ? v : []);
const idOf = (x) => (typeof x === 'string' ? str(x) : str(x?.id));

/** 去掉值为 undefined 的键 */
function compact(o) {
    for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
    return o;
}

/**
 * 读并规整 curation/meta-home.json。没有文件或 JSON 坏了返回 null（并记一条警告）。
 * { collection_groups: [{ key, label, items: [id | {id}] }], bibliographers: [id | {id}], lineage_picks: [id | {id}] }
 */
export function readMetaCuration(file, log = console.log) {
    if (!file || !existsSync(file)) return null;
    let raw;
    try {
        raw = JSON.parse(readFileSync(file, 'utf-8'));
    } catch (e) {
        log(`  ⚠ meta-home: 策展文件读不了，丛编／人物／版本谱系不输出: ${file}: ${e.message}`);
        return null;
    }
    if (!raw || typeof raw !== 'object') return null;
    return {
        collection_groups: arr(raw.collection_groups).filter((g) => str(g?.key) && str(g?.label)).map((g) => ({
            key: str(g.key), label: str(g.label), items: arr(g.items).map(idOf).filter(Boolean),
        })),
        bibliographers: arr(raw.bibliographers).map(idOf).filter(Boolean),
        lineage_picks: arr(raw.lineage_picks).map(idOf).filter(Boolean),
    };
}

/** 存佚计数：详情优先、索引条目兜底（与 indexer 的 lossStatusValue 同口径）；认不出的算 unknown */
export function lossKey(detail, entry) {
    for (const v of [detail?.loss_status, entry?.loss_status]) if (typeof v === 'string' && LOSS_KEYS.includes(v)) return v;
    return 'unknown';
}

/**
 * 作品有没有版本谱系：详情里 version_graph.enabled 为 true（详情页据此出「关系图」，bim core/lineage-graph 同一判据），
 * 或文本目录里有 lineage_graph.json
 */
export function hasLineage(detail, itemTextDir) {
    if (detail?.version_graph?.enabled === true) return true;
    return !!itemTextDir && existsSync(join(itemTextDir, 'lineage_graph.json'));
}

/** 作者行（第一作者，带朝代），与阅读首页卡片同一取法 */
function authorsOf(d) {
    const c = toCard(d);
    return c.authors;
}

/**
 * 纯函数部分：给定已经读好的各份数据，拼出 MetaHomeSections，便于单测。
 * @param {{
 *   index: { works: Record<string, any>, books?: Record<string, any>, collections?: Record<string, any>, entities?: Record<string, any> },
 *   workDetail: (id: string) => any | null,   读作品详情（只对策展里点名的作品调用）
 *   lineageOf: (id: string) => boolean,
 *   loss: { extant: number, partially_extant: number, lost: number, unknown: number },
 *   meta: any, tree: any[] | null, resource: any, resourceSite: any,
 *   readCur: ReturnType<typeof readCuration>, metaCur: ReturnType<typeof readMetaCuration>,
 * }} args
 */
/** 「同类书目与考证」取自阅读首页策展文件里的哪一组：目录总管 10-01 实交的是 shumu（书目与考证），早先约定的是 bibliography */
export const BIBLIOGRAPHY_TOPIC_KEYS = ['shumu', 'bibliography'];

export function buildMetaSections({ index, workDetail, lineageOf, loss, meta, tree, resource, resourceSite, readCur, metaCur }) {
    const works = index.works ?? {};
    const collections = index.collections ?? {};
    const entities = index.entities ?? {};
    const skipped = [];
    const workCard = (id) => {
        if (!works[id]) { skipped.push(id); return null; }
        const d = workDetail(id);
        const title = str(d?.title) ?? str(works[id].title) ?? id;
        return compact({ id, title, authors: d ? authorsOf(d) : undefined });
    };

    // 书目著录进度：resource.json 的 catalog 条目；work_id／collection_id 只在索引里查得到才给（旧式 id 不给，免得链成 404）
    const catalogs = arr(resource?.resources).filter((r) => r && r.type === 'catalog');
    const catalog_progress = catalogs.map((r) => compact({
        id: str(r.id) ?? '',
        name: str(r.name) ?? '',
        edition: str(r.edition),
        total: Number.isFinite(r.total) ? r.total : 0,
        imported: Number.isFinite(r.imported) ? r.imported : 0,
        status: str(r.status) ?? '',
        work_id: str(r.work_id) && works[r.work_id] ? r.work_id : undefined,
        collection_id: str(r.collection_id) && collections[r.collection_id] ? r.collection_id : undefined,
    }));
    const recordsByWork = new Map(catalog_progress.filter((r) => r.work_id).map((r) => [r.work_id, r.total]));

    // 史志书架与同类书目：沿用阅读首页策展文件里 shelf 组、bibliography 组；按全部作品解析（不只可读的）
    const shelfTopic = readCur?.topics.find((t) => t.shelf) ?? null;
    let shelf = null;
    if (shelfTopic) {
        const items = [];
        for (const x of shelfTopic.items) {
            const c = workCard(x.id);
            if (c) items.push(compact({ ...c, period_of: x.period_of, orig: x.orig || undefined, records: recordsByWork.get(x.id) }));
        }
        if (items.length) shelf = { label: shelfTopic.label, items };
    }
    const relTopic = readCur?.topics.find((t) => BIBLIOGRAPHY_TOPIC_KEYS.includes(t.key));
    const related_catalogs = relTopic ? relTopic.items.map((x) => workCard(x.id)).filter(Boolean) : [];

    const collection_groups = [];
    for (const g of metaCur?.collection_groups ?? []) {
        const items = [];
        for (const id of g.items) {
            const c = collections[id];
            if (!c) { skipped.push(id); continue; }
            items.push({ id, title: str(c.title) ?? id });
        }
        if (items.length) collection_groups.push({ key: g.key, label: g.label, items });
    }

    const bibliographers = [];
    for (const id of metaCur?.bibliographers ?? []) {
        const e = entities[id];
        if (!e) { skipped.push(id); continue; }
        bibliographers.push(compact({
            id,
            name: str(e.primary_name) ?? str(e.title) ?? id,
            dynasty: str(e.dynasty),
            birth_year: Number.isFinite(e.birth_year) ? e.birth_year : undefined,
            death_year: Number.isFinite(e.death_year) ? e.death_year : undefined,
        }));
    }

    const lineage = [];
    for (const id of metaCur?.lineage_picks ?? []) {
        if (!works[id] || !lineageOf(id)) { skipped.push(id); continue; }
        const c = workCard(id);
        if (c) lineage.push(c);
    }

    const sites = arr(resourceSite?.resources).filter(Boolean).map((r) => compact({
        id: str(r.id) ?? '',
        name: str(r.name) ?? '',
        url: str(r.url) && /^https?:\/\//.test(r.url) ? r.url : undefined,
        total: Number.isFinite(r.total) ? r.total : 0,
        imported: Number.isFinite(r.imported) ? r.imported : 0,
        status: str(r.status) ?? '',
    }));

    const counts = {
        works: meta?.works ?? Object.keys(works).length,
        books: meta?.books ?? Object.keys(index.books ?? {}).length,
        collections: meta?.collections ?? Object.keys(collections).length,
        entities: meta?.entities ?? Object.keys(entities).length,
    };
    const { bu, unclassified } = summarizeBu(tree ?? []);
    return {
        sections: {
            counts,
            shelf,
            related_catalogs,
            catalog_progress,
            bu,
            unclassified,
            collection_groups,
            bibliographers,
            lineage,
            sites,
            stats: {
                ...counts,
                has_image: meta?.resourceCounts?.hasImage ?? 0,
                has_text: meta?.resourceCounts?.hasText ?? 0,
                article: meta?.subtypeStats?.article ?? 0,
                poem: meta?.subtypeStats?.poem ?? 0,
                loss,
            },
        },
        skipped: [...new Set(skipped)],
    };
}

/**
 * bundle-data.mjs 的入口。
 * @param {{ index: any, rootDirFor: (e: any) => string, textDirFor: (e: any) => string, dataDir: string,
 *   siteDir: string, curationDir?: string|null, log?: (s: string) => void }} args
 * siteDir：resource.json／resource-site.json 所在（book-index 仓根）。
 * curationDir：放 read-home.json、meta-home.json 的目录（生产 book-index 的 curation/）；null 表示不读策展。
 * dataDir 下要先有 meta.json 与 catalog/tree.json（bundleMeta、bundleCatalog 写的）。
 */
export function bundleMetaHome({ index, rootDirFor, textDirFor, dataDir, siteDir, curationDir, log = console.log }) {
    const works = index.works ?? {};
    const detailCache = new Map();
    const workDetail = (id) => {
        if (detailCache.has(id)) return detailCache.get(id);
        const item = works[id];
        const d = item ? readEntryOrNull(item, rootDirFor) : null;
        detailCache.set(id, d);
        return d;
    };
    // 存佚要逐部读详情（详情优先，与 indexer 同口径）
    const loss = { extant: 0, partially_extant: 0, lost: 0, unknown: 0 };
    for (const [id, entry] of Object.entries(works)) {
        const d = readEntryOrNull(entry, rootDirFor);
        if (d?.merged_into) continue;
        loss[lossKey(d, entry)]++;
    }
    const lineageOf = (id) => {
        const item = works[id];
        if (!item) return false;
        const d = workDetail(id);
        return hasLineage(d, join(textDirFor(item), dirname(item.path), id));
    };
    const readCur = curationDir ? readCuration(join(curationDir, 'read-home.json'), log) : null;
    const metaCur = curationDir ? readMetaCuration(join(curationDir, 'meta-home.json'), log) : null;
    const { sections, skipped } = buildMetaSections({
        index,
        workDetail,
        lineageOf,
        loss,
        meta: readJsonOrNull(join(dataDir, 'meta.json')),
        tree: readJsonOrNull(join(dataDir, 'catalog', 'tree.json')),
        resource: readJsonOrNull(join(siteDir, 'resource.json')),
        resourceSite: readJsonOrNull(join(siteDir, 'resource-site.json')),
        readCur,
        metaCur,
    });
    if (skipped.length) log(`  ⚠ meta-home: 策展里 ${skipped.length} 个 id 不存在或不合条件（如没有谱系），已略过：${skipped.slice(0, 10).join('、')}${skipped.length > 10 ? '…' : ''}`);
    const out = join(dataDir, 'meta-home', 'sections.json');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(sections));
    const unlinked = sections.catalog_progress.filter((r) => !r.work_id && !r.collection_id).length;
    log(`META-HOME meta-home/sections.json：书架 ${sections.shelf?.items.length ?? 0}，同类书目 ${sections.related_catalogs.length}，著录进度 ${sections.catalog_progress.length}（${unlinked} 条 id 对不上、不加链接），`
        + `丛编 ${sections.collection_groups.length} 组，人物 ${sections.bibliographers.length}，谱系 ${sections.lineage.length}，存佚 ${LOSS_KEYS.map((k) => sections.stats.loss[k]).join('/')}／未详 ${sections.stats.loss.unknown}`);
    return sections;
}

// ─── 单独运行 ───

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    const { resolveDataDirs } = await import('./lib/data-dirs.mjs');
    const here = dirname(fileURLToPath(import.meta.url));
    const prodDir = resolve(process.argv[2] || process.env.BOOK_INDEX_PRODUCTION_DIR || join(here, '..', '..', 'book-index'));
    const { assertProductionDir, assertSiteContentFiles } = await import('./lib/production-dir.mjs');
    try { assertProductionDir(prodDir); assertSiteContentFiles(prodDir); } catch (e) { console.error(`❌ ${e.message}`); process.exit(1); }
    const textDir = resolve(process.env.BOOK_TEXT_DIR || join(here, '..', '..', 'book-text'));
    const index = { works: {}, books: {}, collections: {}, entities: {} };
    for (const [dir, label] of [[prodDir, 'official']]) {
        const colPath = join(indexDirFor(dir), 'collections.json');
        if (existsSync(colPath)) {
            for (const [id, e] of Object.entries(JSON.parse(readFileSync(colPath, 'utf-8')))) if (!e?.promoted_to) index.collections[id] = { ...e, _root: label };
        }
        for (const typeKey of ['works', 'books', 'entities']) {
            for (let i = 0; i < 16; i++) {
                const p = join(indexDirFor(dir), typeKey, `${i.toString(16)}.json`);
                if (!existsSync(p)) continue;
                for (const [id, e] of Object.entries(JSON.parse(readFileSync(p, 'utf-8')))) {
                    if (e?.promoted_to) continue;
                    index[typeKey][id] = { ...e, _root: label };
                }
            }
        }
    }
    bundleMetaHome({
        index,
        rootDirFor: () => prodDir,
        textDirFor: () => textDir,
        dataDir: resolveDataDirs().dataDir,
        siteDir: prodDir,
        curationDir: join(prodDir, 'curation'),
    });
    if (reportEntryReads().fail) process.exit(1);
}
