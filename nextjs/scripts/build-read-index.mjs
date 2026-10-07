#!/usr/bin/env node
/**
 * build-read-index.mjs — 阅读首页 /read 的构建期「可读条目」索引（overview#267 第 16 项；首页分区 overview#308）
 *
 * 与 build-catalog-index.mjs 同一套做法，网站自己在构建时生成、随数据同步到 current/read/，
 * 不在请求时读 Meili（没有 1000 条上限，搜索机挂了阅读首页也能开）：
 *   read/sections.json             ReadSections：阅读首页各分区（推荐、专题、名著与版本、四部、年代带、单篇诗文）与计数
 *   read/period/<p>/<page>.json    ReadCard[]：某年代段的可读条目，每页 20 条（书在前、单篇在后，再按书名）；p 见 READ_PERIODS
 *   read/featured.json             { collated: ReadCard[], books: ReadCard[] }（旧首页用；首页换成 sections 后删）
 *   read/tree.json                 CatalogNode[]：与古籍总目同一套分类树与节点 id，
 *                                   只计「可读」的 Work，没有可读条目的节点不出现
 *   read/<nodeId>/<page>.json      ReadCard[]：该节点（含子孙）下的可读 Work，每页 20 条，
 *                                   有整理本的在前，再按书名（拼音序）；page 从 1 起
 *
 * 可读＝**站内真有正文**（overview#306），只认新结构（overview#307 §十）：条目目录有 manifest.json，
 *   有可公开版本、且该版本 index.json 章目录非空；internal 版本不算。没有 manifest 的条目不可读。
 * 构建期再逐卡核对产物里的 manifest、各版本目录与首章文件在不在（bundleRead 的 verifyItems），缺则构建失败。
 *
 * ReadCard { id, title, edition?, juan?, authors?: {name, dynasty?}[], collated?: true, classification?: string[],
 *            period?: string, subtype?: string, text_count: number, work_id?: string }
 *   period：年代段 key（READ_PERIODS），按第一位有朝代的作者算，Book 没有就借所属 Work 的；认不出的不写
 *   subtype：作品子类（article／poem／chapter…），书（book 或未写）不写
 *   text_count：Work＝自身可读版本数＋同 work_id 的可读 Book 数；Book＝自身可读版本数＋同 work_id 的其他可读 Book 数
 *   work_id：Book 所属的 Work
 *
 * 策展数据（推荐、专题分组、名著版本系统）来自数据仓 curation/read-home.json（overview#308 B 块，格式见 readCuration）；
 * 默认在 classific.json 同一个仓里找。文件没有或读不了时这三块输出空数组（首页整块不显示），**不让构建失败**。
 *
 * 用法：bundle-data.mjs 在总目之后调用 bundleRead()（正常流程）；
 *       node scripts/build-read-index.mjs [bookIndexDir]   单独重建
 */
import { existsSync, readFileSync, readdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { chapterTxtFile, newStructureReadable, readManifest } from './lib/text-layout.mjs';
import {
    buildCatalog,
    taxonomyRank,
    titleSortKey,
    toCard,
    UNCLASSIFIED_ID,
    writeCatalog,
} from './build-catalog-index.mjs';

export const READ_PAGE_SIZE = 20;
/** 推荐、专题等每组在首页最多列几项由前端定；这里只限单篇诗文的作者数与每位的篇数 */
export const PIECE_AUTHORS_MAX = 8;
export const PIECE_ITEMS_MAX = 4;
/** 四部方块每部列几个子类 */
export const BU_TOP_CHILDREN = 6;
const collator = new Intl.Collator('zh');

/**
 * 年代段（设计稿「按年代」9 段）。key 用在地址 /read?period=<key> 与 read/period/<key>/。
 * dynasties：索引里 dynasty 的取值（繁体；简体在 periodOf 里先转）。新出现的取值要补进来。
 */
export const READ_PERIODS = [
    { key: 'xianqin', label: '先秦', dynasties: ['先秦', '上古', '夏', '商', '殷', '周', '西周', '東周', '春秋', '戰國'] },
    { key: 'qinhan', label: '秦漢', dynasties: ['秦', '漢', '西漢', '東漢', '後漢', '新', '秦漢', '兩漢'] },
    {
        key: 'weijin', label: '魏晉南北朝', dynasties: [
            '三國', '魏', '蜀', '吳', '晉', '西晉', '東晉', '兩晉', '魏晉', '十六國', '南北朝', '南朝', '北朝', '劉宋', '齊', '南齊', '梁', '陳',
            '北魏', '東魏', '西魏', '北齊', '北周', '前秦', '後秦', '前涼', '後涼', '西涼', '北涼', '南涼', '前燕', '後燕', '南燕', '北燕', '成漢', '夏國',
        ],
    },
    {
        key: 'suitang', label: '隋唐五代', dynasties: [
            '隋', '唐', '隋唐', '五代', '十國', '五代十國', '後梁', '後唐', '後晉', '後周', '前蜀', '後蜀', '南唐', '吳越', '閩', '南漢', '北漢', '楚', '荊南', '南平',
        ],
    },
    { key: 'song', label: '宋', dynasties: ['宋', '北宋', '南宋', '兩宋', '宋末元初', '趙宋'] },
    { key: 'liaojinyuan', label: '遼金元', dynasties: ['遼', '金', '元', '西夏', '蒙古', '遼金', '元末明初'] },
    { key: 'ming', label: '明', dynasties: ['明', '南明', '明末清初'] },
    { key: 'qing', label: '清', dynasties: ['清', '晚清', '清末', '清末民初'] },
    { key: 'modern', label: '近現代', dynasties: ['民國', '中華民國', '近代', '現代', '當代', '近現代'] },
];
const PERIOD_KEYS = new Set(READ_PERIODS.map((p) => p.key));
const DYNASTY_TO_PERIOD = new Map(READ_PERIODS.flatMap((p) => p.dynasties.map((d) => [d, p.key])));
// 朝代名里常见的简体字 → 繁体（索引里大多是繁体，偶有简体）
const S2T = { 汉: '漢', 晋: '晉', 东: '東', 两: '兩', 国: '國', 战: '戰', 辽: '遼', 齐: '齊', 陈: '陳', 吴: '吳', 后: '後', 刘: '劉', 赵: '趙', 闽: '閩', 荆: '荊', 当: '當', 现: '現', 凉: '涼', 鲁: '魯' };

/** 朝代名 → 年代段 key；认不出（含外国、空）返回 null */
export function periodOf(dynasty) {
    if (typeof dynasty !== 'string') return null;
    let s = Array.from(dynasty.trim().replace(/[\s〔〕［］[\]()（）]/g, ''), (c) => S2T[c] ?? c).join('');
    if (!s) return null;
    for (let i = 0; i < 2; i++) {
        const hit = DYNASTY_TO_PERIOD.get(s);
        if (hit) return hit;
        // 「南朝梁」「三國魏」「北朝齊」：按前缀归段
        if (/^(南朝|北朝|三國)/.test(s)) return 'weijin';
        if (/^五代/.test(s)) return 'suitang';
        // 「清代」「唐朝」「明人」：去掉后缀再认一次（「五代」「南朝」已在表里）
        const next = s.replace(/(朝|代|人|初|末|中葉|中期|前期|後期)$/, '');
        if (next === s || !next) break;
        s = next;
    }
    return null;
}

/** 卡片：总目卡片去掉提要，加整理本标记与首页分区要的字段 */
export function toReadCard(d, { collated = false, textCount = 1, period = null } = {}) {
    const c = toCard(d);
    delete c.summary;
    // 版本名（Book 的 edition）：同名书（《钦定四库全书总目》《脂砚斋重评石头记》等）靠它在卡片上分辨
    if (typeof d.edition === 'string' && d.edition.trim()) c.edition = d.edition.trim();
    if (collated) c.collated = true;
    const p = period ?? cardPeriod(c, d);
    if (p) c.period = p;
    if (typeof d.subtype === 'string' && d.subtype.trim() && d.subtype.trim() !== 'book') c.subtype = d.subtype.trim();
    c.text_count = textCount;
    if (typeof d.work_id === 'string' && d.work_id.trim()) c.work_id = d.work_id.trim();
    return c;
}

/** 第一位有朝代的作者 → 年代段；都没有就看条目本身的 dynasty */
function cardPeriod(card, d) {
    for (const a of card.authors ?? []) {
        const p = periodOf(a.dynasty);
        if (p) return p;
    }
    return periodOf(d.dynasty);
}

/** 有整理本在前，再按书名拼音，最后按 id（输出稳定） */
export function compareReadCards(a, b) {
    const ca = a.collated ? 0 : 1;
    const cb = b.collated ? 0 : 1;
    if (ca !== cb) return ca - cb;
    return compareTitle(a, b);
}

function compareTitle(a, b) {
    const t = collator.compare(titleSortKey(a.title), titleSortKey(b.title));
    if (t !== 0) return t;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

const isPiece = (c) => c.subtype === 'article' || c.subtype === 'poem';

/** 年代分页的排序：书在前、单篇诗文在后，再按书名 */
export function comparePeriodCards(a, b) {
    const pa = isPiece(a) ? 1 : 0;
    const pb = isPiece(b) ? 1 : 0;
    if (pa !== pb) return pa - pb;
    return compareTitle(a, b);
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

/** 新结构条目的核对清单：manifest.json 一条，每个可读版本的 index.json 与首章（有 json 的再加首章 json） */
function pushNewProbes(probes, id, nt) {
    probes.push({ id, kind: 'manifest' });
    for (const v of nt.versions) probes.push({ id, kind: 'text', key: v.key, first: v.first });
}

// ─── 策展数据 curation/read-home.json ───

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const idOf = (x) => (typeof x === 'string' ? str(x) : str(x?.id));

/**
 * 读并规整策展文件。格式（字段都可缺，认不出的项跳过）：
 *   {
 *     picks:  [{ id, blurb, slip?, type_label? }],                       推荐阅读，按数组顺序
 *     topics: [{ key, label, shelf?: true | layout?: 'shelf'|'list',     专题分组；shelf（或 layout: 'shelf'，目录总管 10-01 实交的写法）＝画成书脊架（史志目录）
 *                items: [id | { id, period_of?, orig?: true }] }],      period_of：所志朝代；orig：正史原志
 *     famous: [{ title, authors?: string, work_id?,                      名著与版本，一部作品一张卡
 *                systems?: [{ label?, items: [id | { id, short? }] }] }] 版本系统分行；没有 systems 就按 work_id 平铺可读 Book
 *   }
 * 文件不存在返回 null；JSON 坏了记一条警告并返回 null（首页这几块不显示，构建照常）。
 */
export function readCuration(file, log = console.log) {
    if (!file || !existsSync(file)) return null;
    let raw;
    try {
        raw = JSON.parse(readFileSync(file, 'utf-8'));
    } catch (e) {
        log(`  ⚠ read: 策展文件读不了，推荐／专题／名著不输出: ${file}: ${e.message}`);
        return null;
    }
    if (!raw || typeof raw !== 'object') return null;
    const arr = (v) => (Array.isArray(v) ? v : []);
    return {
        picks: arr(raw.picks).filter((p) => idOf(p)).map((p) => ({
            id: idOf(p), blurb: str(p.blurb), slip: str(p.slip), type_label: str(p.type_label),
        })),
        topics: arr(raw.topics).filter((t) => str(t?.key) && str(t?.label)).map((t) => ({
            key: str(t.key), label: str(t.label), shelf: t.shelf === true || t.layout === 'shelf',
            items: arr(t.items).filter(idOf).map((x) => ({
                id: idOf(x), period_of: str(x?.period_of), orig: x?.orig === true,
            })),
        })),
        famous: arr(raw.famous).filter((f) => str(f?.title)).map((f) => ({
            title: str(f.title), authors: str(f.authors), work_id: str(f.work_id),
            systems: Array.isArray(f.systems)
                ? f.systems.map((s) => ({
                    label: str(s?.label) ?? '',
                    items: arr(s?.items).filter(idOf).map((x) => ({ id: idOf(x), short: str(x?.short) })),
                }))
                : null,
        })),
    };
}

/** 去掉值为 undefined／false 的可选键 */
function compact(o) {
    for (const k of Object.keys(o)) if (o[k] === undefined || o[k] === false) delete o[k];
    return o;
}

/**
 * 四部方块：经史子集各部的总数与前几个子类（按数量），未分類单列。阅读首页与元数据首页（build-meta-home）共用。
 * @param {object[]} tree CatalogNode[]
 */
export function summarizeBu(tree) {
    const bu = [];
    let unclassified = 0;
    for (const n of tree ?? []) {
        if (n.id === UNCLASSIFIED_ID) { unclassified = n.count; continue; }
        const kids = [...(n.children ?? [])].sort((a, b) => b.count - a.count || collator.compare(a.label, b.label));
        bu.push({
            id: n.id, label: n.label, count: n.count, children_total: kids.length,
            top: kids.slice(0, BU_TOP_CHILDREN).map((k) => ({ id: k.id, label: k.label, count: k.count })),
        });
    }
    return { bu, unclassified };
}

/**
 * 首页分区（纯函数，便于单测）。
 * @param {{ works: object[], books: object[], tree: object[], curation: ReturnType<typeof readCuration> }} args
 *   works／books：可读条目的 ReadCard
 */
export function buildSections({ works, books, tree, curation }) {
    const all = [...works, ...books];
    const byId = new Map(all.map((c) => [c.id, c]));
    const booksByWork = new Map();
    for (const b of books) if (b.work_id) (booksByWork.get(b.work_id) ?? booksByWork.set(b.work_id, []).get(b.work_id)).push(b);
    const skipped = [];
    const card = (id) => {
        const c = byId.get(id);
        if (!c) skipped.push(id);
        return c;
    };

    const picks = [];
    for (const p of curation?.picks ?? []) {
        const c = card(p.id);
        if (c) picks.push(compact({ ...c, blurb: p.blurb, slip: p.slip, type_label: p.type_label }));
    }

    const topics = [];
    for (const t of curation?.topics ?? []) {
        const seen = new Set();
        const items = [];
        for (const x of t.items) {
            if (seen.has(x.id)) continue;
            seen.add(x.id);
            const c = card(x.id);
            if (c) items.push(compact({ ...c, period_of: x.period_of, orig: x.orig }));
        }
        if (items.length) topics.push(compact({ key: t.key, label: t.label, shelf: t.shelf, items }));
    }

    const famous = [];
    for (const f of curation?.famous ?? []) {
        const systems = [];
        if (f.systems) {
            for (const s of f.systems) {
                const items = [];
                for (const x of s.items) {
                    const c = card(x.id);
                    if (c) items.push(compact({ id: c.id, short: x.short ?? c.edition ?? c.title, title: c.title, edition: c.edition }));
                }
                if (items.length) systems.push({ label: s.label, items });
            }
        } else if (f.work_id) {
            const list = [...(byId.has(f.work_id) ? [byId.get(f.work_id)] : []), ...(booksByWork.get(f.work_id) ?? []).sort(compareTitle)];
            const items = list.map((c) => compact({ id: c.id, short: c.edition ?? c.title, title: c.title, edition: c.edition }));
            if (items.length) systems.push({ label: '', items });
        }
        const n = systems.reduce((s, x) => s + x.items.length, 0);
        if (n) famous.push(compact({ title: f.title, authors: f.authors, work_id: f.work_id, text_count: n, systems }));
    }

    const { bu, unclassified } = summarizeBu(tree);

    // 年代带：每段部数；认不出朝代的单计
    const periodCounts = new Map(READ_PERIODS.map((p) => [p.key, 0]));
    let periodUnknown = 0;
    for (const c of all) {
        if (c.period && periodCounts.has(c.period)) periodCounts.set(c.period, periodCounts.get(c.period) + 1);
        else periodUnknown++;
    }
    const periods = READ_PERIODS.map((p) => ({ key: p.key, label: p.label, count: periodCounts.get(p.key) }));

    // 单篇诗文：按第一作者分组，篇数多的在前，取前几位
    const pieces = all.filter(isPiece);
    const byAuthor = new Map();
    for (const c of pieces) {
        const a = c.authors?.[0];
        if (!a) continue;
        const g = byAuthor.get(a.name) ?? byAuthor.set(a.name, { name: a.name, dynasty: a.dynasty, items: [] }).get(a.name);
        if (!g.dynasty && a.dynasty) g.dynasty = a.dynasty;
        g.items.push(c);
    }
    const authors = [...byAuthor.values()]
        .sort((a, b) => b.items.length - a.items.length || collator.compare(a.name, b.name))
        .slice(0, PIECE_AUTHORS_MAX)
        .map((g) => compact({ name: g.name, dynasty: g.dynasty, count: g.items.length, items: g.items.sort(compareTitle).slice(0, PIECE_ITEMS_MAX) }));

    return {
        sections: {
            counts: { readable: all.length, works: works.length, books: books.length, pieces: pieces.length },
            picks,
            topics,
            famous,
            bu,
            unclassified,
            periods,
            period_unknown: periodUnknown,
            pieces: { count: pieces.length, authors },
        },
        skipped: [...new Set(skipped)],
    };
}

/** 各年代段的分页清单 { key → ReadCard[] }（只含有条目的段） */
export function buildPeriodLists(cards) {
    const lists = new Map();
    for (const c of cards) {
        if (!c.period || !PERIOD_KEYS.has(c.period)) continue;
        (lists.get(c.period) ?? lists.set(c.period, []).get(c.period)).push(c);
    }
    for (const list of lists.values()) list.sort(comparePeriodCards);
    return lists;
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
 *   textDirFor: (e: any) => string, dataDir: string, taxonomyFile?: string, curationFile?: string|null,
 *   verifyItems?: boolean, log?: (s: string) => void }} args
 * textDirFor：条目 → 文本仓根目录（文本都在那里，不在元数据仓）。
 * curationFile：策展文件；不传时取 taxonomyFile 同仓的 curation/read-home.json，传 null 表示不读。
 * verifyItems：true 时构建后逐卡核对 dataDir/items/ 下的 manifest 与各版本首章文件，缺则抛错（bundle-data 开）。
 */
export function bundleRead({ index, rootDirFor, textDirFor, dataDir, taxonomyFile, curationFile, verifyItems = false, log = console.log }) {
    const rank = taxonomyFile && existsSync(taxonomyFile)
        ? taxonomyRank(JSON.parse(readFileSync(taxonomyFile, 'utf-8')))
        : new Map();
    let merged = 0;
    /** 构建期核对清单：{ id, kind: 'manifest'|'text', key?, first? } */
    const probes = [];

    /** 可读条目：[{ d, nt }]；读不了、被并、不可读的跳过 */
    function readable(entries, onMerged) {
        const out = [];
        for (const item of Object.values(entries ?? {})) {
            const p = join(rootDirFor(item), item.path);
            if (!existsSync(p)) continue;
            const d = readJsonSafe(p, log, item.path);
            if (!d || d.merged_into) { if (d) onMerged(); continue; }
            if (!d.id) d.id = item.id;
            const itemDir = join(textDirFor(item), dirname(item.path), d.id);
            if (!readManifest(itemDir)) continue;
            const nt = newStructureReadable(itemDir);
            if (!nt) continue;
            pushNewProbes(probes, d.id, nt);
            out.push({ d, nt });
        }
        return out;
    }
    const rw = readable(index.works, () => merged++);
    const rb = readable(index.books, () => {});

    // text_count 要知道每部 Work 下有几本可读 Book
    const bookCountByWork = new Map();
    for (const { d } of rb) {
        const w = str(d.work_id);
        if (w) bookCountByWork.set(w, (bookCountByWork.get(w) ?? 0) + 1);
    }
    const workCards = new Map();
    const works = rw.map(({ d, nt }) => {
        const card = toReadCard(d, { collated: nt.collated, textCount: nt.versions.length + (bookCountByWork.get(d.id) ?? 0) });
        workCards.set(d.id, card);
        return { d, card };
    });
    // Book 自己的作者没朝代时借所属 Work 的年代段（Work 不可读时去读它的详情）
    const workPeriod = (wid) => {
        if (workCards.has(wid)) return workCards.get(wid).period ?? null;
        const item = index.works?.[wid];
        if (!item) return null;
        const p = join(rootDirFor(item), item.path);
        const d = existsSync(p) ? readJsonSafe(p, log, item.path) : null;
        return d ? cardPeriod(toCard(d), d) : null;
    };
    const books = rb.map(({ d, nt }) => {
        const w = str(d.work_id);
        const own = toReadCard(d, { textCount: nt.versions.length + (w ? bookCountByWork.get(w) - 1 : 0) });
        if (!own.period && w) {
            const p = workPeriod(w);
            if (p) own.period = p;
        }
        return own;
    }).sort(compareReadCards);

    const built = buildRead(works, { rank });
    const workList = works.map((w) => w.card);
    const collatedUnique = workList.filter((c) => c.collated).sort(compareReadCards);

    const curPath = curationFile === undefined
        ? (taxonomyFile ? join(dirname(taxonomyFile), 'curation', 'read-home.json') : null)
        : curationFile;
    const curation = readCuration(curPath, log);
    const { sections, skipped } = buildSections({ works: workList, books, tree: built.tree, curation });
    if (skipped.length) log(`  ⚠ read: 策展文件里 ${skipped.length} 个 id 不可读或不存在，已略过：${skipped.slice(0, 10).join('、')}${skipped.length > 10 ? '…' : ''}`);

    const extra = { 'featured.json': { collated: collatedUnique, books }, 'sections.json': sections };
    const periodLists = buildPeriodLists([...workList, ...books]);
    for (const [key, list] of periodLists) {
        const pages = Math.max(1, Math.ceil(list.length / READ_PAGE_SIZE));
        for (let p = 1; p <= pages; p++) extra[`period/${key}/${p}.json`] = list.slice((p - 1) * READ_PAGE_SIZE, p * READ_PAGE_SIZE);
    }

    const w = writeCatalog(dataDir, built, { dirName: 'read', pageSize: READ_PAGE_SIZE, extra });
    if (verifyItems) {
        const missing = verifyReadProbes(probes, dataDir);
        if (missing.length) {
            const head = missing.slice(0, 30).map((m) => `  - ${m}`).join('\n');
            throw new Error(`read/ 有 ${missing.length} 处阅读卡片对应的数据文件在产物里缺失（overview#306）：\n${head}${missing.length > 30 ? '\n  …' : ''}`);
        }
        log(`    核对 ${probes.length} 项阅读入口的数据文件：全部在产物里`);
    }
    log(`READ read/: 可读 Work ${built.stats.total}（有分类 ${built.stats.classified}，未分類 ${built.stats.unclassified}；跳过被并 ${merged}），Book ${books.length}，单篇 ${sections.counts.pieces}`);
    log(`    首页分区：推荐 ${sections.picks.length}，专题 ${sections.topics.length} 组，名著 ${sections.famous.length}${curation ? '' : '（没有策展文件）'}；年代 ${periodLists.size} 段，无朝代 ${sections.period_unknown}`);
    log(`    ${built.lists.size} 个节点，${w.files} 个文件（${(w.bytes / 1024 / 1024).toFixed(1)} MB），删旧 ${w.removed}`);
    return { ...built, collated: collatedUnique, books, sections, written: w };
}

/**
 * 构建期核对：每张阅读卡对应的 manifest 与各可读版本的 index.json、首章文件，在产物 dataDir/items/<id>/ 下都存在（.md 已改名 .txt）。
 * 返回缺失清单（空＝全部在）。
 */
export function verifyReadProbes(probes, dataDir) {
    const missing = [];
    const need = (id, rel) => {
        if (!existsSync(join(dataDir, 'items', id, rel))) missing.push(`${id}: items/${id}/${rel}`);
    };
    for (const p of probes) {
        if (p.kind === 'manifest') {
            need(p.id, 'manifest.json');
        } else if (p.kind === 'text') {
            need(p.id, `${p.key}/index.json`);
            // 整理本的章可以只有结构化 json、没有 md（has_json 时 md 可缺）；其余章 md 必须在
            // 对读章（自校本）真源是 char.json，不产 md／txt：声明了 char_file 就核对它
            if (p.first.charFile) need(p.id, `${p.key}/${p.first.charFile}`);
            else if (!p.first.hasJson) need(p.id, `${p.key}/${chapterTxtFile(p.first.file)}`);
            if (p.first.hasJson) need(p.id, `${p.key}/${p.first.file.replace(/\.(md|txt)$/, '')}.json`);
        }
    }
    return missing;
}

// ─── 过渡：bundle-data.mjs 的旧标记（has_site_fulltext／has_full_text）还在用，#307 §十 清理时随调用方一起删 ───

function readJsonOrNull(p) {
    try {
        return JSON.parse(readFileSync(p, 'utf-8'));
    } catch {
        return null;
    }
}

/** @deprecated 旧结构。Work 全文：index/full_text 分片里该 Work 的条目，返回阅读页会选的那一个，没有返回 null */
export function workFullTextPick(list) {
    const ok = (Array.isArray(list) ? list : []).filter((v) => v && v.owner_type !== 'Book' && typeof v.key === 'string' && v.total_chapters > 0);
    return ok.find((v) => v.primary) ?? ok[0] ?? null;
}

/** @deprecated 旧结构。Book 全文：full_text/index.json 有非空 chapters。返回首章文件名，不可读返回 null */
export function bookFirstChapter(itemDir) {
    const idx = readJsonOrNull(join(itemDir, 'full_text', 'index.json'));
    const ch = Array.isArray(idx?.chapters) ? idx.chapters.find((c) => typeof c?.file === 'string' && c.file) : null;
    return ch ? ch.file : null;
}

/** @deprecated 旧结构。读 book-text/index/full_text/*.json 合并成 { workId: entry[] } */
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

// ─── 单独运行 ───

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    const { resolveDataDirs } = await import('./lib/data-dirs.mjs');
    const here = dirname(fileURLToPath(import.meta.url));
    const prodDir = resolve(process.argv[2] || process.env.BOOK_INDEX_PRODUCTION_DIR || join(here, '..', '..', 'book-index'));
    const { assertProductionDir } = await import('./lib/production-dir.mjs');
    try { assertProductionDir(prodDir); } catch (e) { console.error(`❌ ${e.message}`); process.exit(1); }
    const textDir = resolve(process.env.BOOK_TEXT_DIR || join(here, '..', '..', 'book-text'));
    const index = { works: {}, books: {} };
    for (const [dir, label] of [[prodDir, 'official']]) {
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
        rootDirFor: () => prodDir,
        textDirFor: () => textDir,
        dataDir: resolveDataDirs().dataDir,
        taxonomyFile: join(prodDir, 'classific.json'),
    });
}
