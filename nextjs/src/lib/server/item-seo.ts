/**
 * 条目页头部与结构化数据（W2-2，31 卡 §A.5 字段表）。
 *
 * 只用本条目 JSON 自己有的字段（§A.6「服务端只渲染本条目 JSON 里有的东西」），
 * 这样「哪些页要清缓存」恰好等于「哪些条目变了」。别的条目的页面只以 URL 引用
 * （workExample、exampleOfWork、isPartOf、hasPart、author.@id），不取它们的字段。
 * JSON-LD 不从 ai_note 等内部字段取；description 与 meta description 同源。
 * SEO2（overview#130）：description 按类型模板化到 80–160 字（缺字段就省，不编造），
 * JSON-LD 补 @id、genre、isPartOf、publisher 等能从本条目取到的字段。
 */
import type { ItemEntry } from './item-data';
import { summarizeItem, sentences, lossStatusText } from './item-summary';
import { isValidItemId } from '../item-id';

/** meta description 的长度区间（按码点）：短于下限才补站名句，长于上限截断 */
export const SEO_DESC_MIN = 80;
export const SEO_DESC_MAX = 160;

type Json = Record<string, unknown>;

export interface ItemSeo {
    title: string;
    description: string;
    /** 站内路径，如 /item/<id>；由 layout 的 metadataBase 补成绝对地址 */
    canonicalPath: string;
    ogType: 'book' | 'website' | 'profile';
    jsonLd: Json;
}

function str(v: unknown): string {
    return typeof v === 'string' ? v.trim() : '';
}

function arr(v: unknown): unknown[] {
    return Array.isArray(v) ? v : [];
}

function obj(v: unknown): Json {
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {};
}

function len(s: string): number {
    return Array.from(s).length;
}

/** 截到 max 个字（按 Unicode 码点，不切坏扩展区汉字），超出加省略号 */
export function clip(text: string, max = SEO_DESC_MAX): string {
    const t = text.replace(/\s+/g, ' ').trim();
    const cps = Array.from(t);
    return cps.length <= max ? t : `${cps.slice(0, max - 1).join('')}…`;
}

/** 被并条目的去向：merged_into 是合法、且不等于自己的 id 才算 */
export function mergedTarget(e: ItemEntry, id: string): string | null {
    const m = e.merged_into;
    const target = typeof m === 'string' ? m : (m && typeof m === 'object' ? str((m as Json).id) : '');
    return target && target !== id && isValidItemId(target) ? target : null;
}

/** 句子补句号（已有句末标点则不补） */
function stop(s: string): string {
    const t = s.trim().replace(/[，、,\s]+$/, '');
    return !t || /[。！？；…]$/.test(t) ? t : `${t}。`;
}

function uniq(xs: string[]): string[] {
    return [...new Set(xs.filter(Boolean))];
}

/** 书名号：已带《》的不重复加 */
function bookName(t: string): string {
    return /^《.*》$/.test(t) ? t : `《${t}》`;
}

/** 生成简介里的套话：信息量低，排到最后，篇幅有余才用 */
const BOILERPLATE = [/^本書惟.*別無他證/, /賴之以存。?$/];

/**
 * 简介里能进 description 的句子：去掉只是重复书名／作者／卷数的开头句
 * （作品简介多以「某某（明）撰。十二卷。」起头，与前面模板拼出的内容重复）。
 */
function freshSentences(text: string, known: string[]): string[] {
    const keys = uniq(known.map((k) => k.trim())).sort((a, b) => len(b) - len(a));
    const kept = sentences(text).filter((sen) => {
        let rest = sen;
        for (const k of keys) rest = rest.split(k).join('');
        return rest.replace(/[\s，、。；：:,.()（）《》「」撰著編纂注輯]/g, '') !== '';
    });
    const boiler = (sen: string) => BOILERPLATE.some((re) => re.test(sen));
    return [...kept.filter((x) => !boiler(x)), ...kept.filter(boiler)];
}

/**
 * 按顺序拼句子，总长不过 SEO_DESC_MAX：放不下的句子跳过、试下一句（后面的往往更短），
 * 一句都放不下的开头句（长简介）截断收尾。
 */
function assemble(head: string[], body: string[], tail: string[]): string {
    let out = '';
    const add = (s: string) => {
        const t = stop(s);
        if (!t) return true;
        if (len(out) + len(t) > SEO_DESC_MAX) return false;
        out += t;
        return true;
    };
    head.forEach(add);
    for (const s of body) {
        if (!add(s) && len(out) < SEO_DESC_MIN) {
            out += clip(stop(s), SEO_DESC_MAX - len(out));
            break;
        }
    }
    tail.forEach(add);
    return out;
}

/**
 * 作者一行：与首屏摘要的 authorLine 同格式「（朝代）名角色」，
 * 只是角色里混进的英文占位（如「author」）不进 description。
 */
function authorsOf(e: ItemEntry): { names: string[]; line: string } {
    const as = arr(e.authors).map(obj).filter((a) => str(a.name));
    const role = (a: Json) => (/[A-Za-z]/.test(str(a.role)) ? '' : str(a.role));
    return {
        names: uniq(as.flatMap((a) => [str(a.name), str(a.dynasty), role(a)])),
        line: uniq(as.map((a) => `${str(a.dynasty) ? `（${str(a.dynasty)}）` : ''}${str(a.name)}${role(a)}`)).join('、'),
    };
}

/** 人物著录作品：总数，外加按角色的分项（只有一种角色时不列） */
function worksText(e: ItemEntry): string {
    const ws = arr(e.works).map(obj);
    if (!ws.length) return '';
    const by = new Map<string, number>();
    for (const w of ws) {
        const r = str(w.role);
        if (r) by.set(r, (by.get(r) ?? 0) + 1);
    }
    const detail = by.size > 1 ? `（${[...by.entries()].map(([r, n]) => `${r} ${n}`).join('、')}）` : '';
    return `本站著錄其作品 ${ws.length} 部${detail}`;
}

function classificationText(e: ItemEntry): string {
    const c = obj(e.classification);
    const parts = [str(c.l1), str(c.l2), str(c.l3)].filter(Boolean);
    return parts.length ? `屬${parts.join('')}` : '';
}

/**
 * 著录书目：取 indexed_by 的 source，最多举三种。
 * quoted：前面已引了哪一种的原文——它不再重复列，其余写「又見著錄於」。
 */
function indexedText(e: ItemEntry, desc: string, quoted = ''): string {
    const all = uniq(arr(e.indexed_by).map((x) => str(obj(x).source)));
    // 简介里已写了「見著錄於《…》」就不再重复
    if (!all.length || (!quoted && all.some((s) => desc.includes(s)))) return '';
    const srcs = all.filter((s) => s !== quoted);
    if (!srcs.length) return '';
    const shown = srcs.slice(0, 3).map(bookName).join('');
    const lead = quoted ? '又見著錄於' : '見著錄於';
    return srcs.length > 3 ? `${lead}${shown}等 ${srcs.length} 種書目` : `${lead}${shown}`;
}

/**
 * 没有简介的作品：引第一条书目著录的原文（indexed_by[].summary），句首标出处。
 * 这是条目自己带的著录原文，不是改写。
 */
function indexedQuote(e: ItemEntry, known: string[]): { source: string; body: string[] } | null {
    for (const x of arr(e.indexed_by)) {
        const src = str(obj(x).source);
        const sum = str(obj(x).summary);
        if (!src || !sum) continue;
        const ss = freshSentences(sum, known);
        if (!ss.length) continue;
        return { source: src, body: [`${bookName(src)}著錄：${ss[0]}`, ...ss.slice(1)] };
    }
    return null;
}

function resourcesText(e: ItemEntry): string {
    const names = uniq(arr(e.resources).map((r) => str(obj(r).short_name) || str(obj(r).name))).slice(0, 3);
    return names.length ? `相關資源：${names.join('、')}` : '';
}

function yearText(v: unknown): string {
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? Number(v) : NaN;
    if (!Number.isFinite(n) || n === 0) return '';
    return n < 0 ? `前${-n}` : String(n);
}

function lifeText(e: ItemEntry): string {
    const d = obj(e.dates);
    const b = yearText(e.birth_year ?? d.birth);
    const x = yearText(e.death_year ?? d.death);
    if (b && x) return `${b}—${x}`;
    if (b) return `生於${b}年`;
    if (x) return `卒於${x}年`;
    return '';
}

/** 别名按类型分组：字、號、別名、諡號…；著录形等内部类型不出 */
const ALT_LABEL: Record<string, string> = { 字: '字', 號: '號', 別名: '又名', 諡號: '諡', 法號: '法號', 廟號: '廟號', 行第: '行' };

function altNamesText(e: ItemEntry): string {
    const by = new Map<string, string[]>();
    for (const a of arr(e.alt_names)) {
        const n = typeof a === 'string' ? a.trim() : str(obj(a).name);
        const t = typeof a === 'string' ? '' : str(obj(a).type);
        const label = t ? ALT_LABEL[t] : '又稱';
        if (!n || !label) continue;
        by.set(label, [...(by.get(label) ?? []), n]);
    }
    const order = Object.values(ALT_LABEL).concat('又稱');
    return [...by.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([label, ns]) => `${label}${uniq(ns).slice(0, 3).join('、')}`).join('，');
}

/** 出版年：纯数字（含区间）加「年」；带年号的原样；推算的、只有朝代名的不出 */
function pubYearText(y: string): string {
    if (/^\d{3,4}(\s*[-–]\s*(\d{3,4})?)?$/.test(y)) return `${y} 年`;
    if (/推算/.test(y) || !/[0-9年]/.test(y)) return '';
    return y;
}

function pubText(e: ItemEntry): string {
    const p = obj(e.publication_info);
    const pub = str(p.publisher);
    const y = pubYearText(str(p.year) || (typeof p.year === 'number' ? String(p.year) : ''));
    if (pub) return `${pub}${y ? ` ${y}` : ''}出版`;
    const det = str(p.details);
    if (det && len(det) <= 40) return det;
    // 没有出版者时只写年代：石经、简帛的「year」是刻写／下葬年代，说「出版」不对
    return y;
}

function countText(e: ItemEntry): string {
    const c = obj(e.count);
    const n = (k: string) => (typeof c[k] === 'number' && (c[k] as number) > 0 ? (c[k] as number) : 0);
    const parts = [
        n('zhong') && `收書 ${n('zhong')} 種`,
        n('juan') && `${n('juan')} 卷`,
        n('ce') && `${n('ce')} 冊`,
    ].filter(Boolean) as string[];
    if (parts.length) return parts.join('，');
    const members = arr(e.contained_works).length + arr(e.books).length;
    return members ? `本站收錄其子目 ${members} 種` : '';
}

function provenanceText(e: ItemEntry): string {
    const p = obj(arr(e.provenance)[0]);
    const inst = str(p.institution);
    if (!inst) return '';
    const call = str(p.call_number);
    return `${inst}藏${call ? `，索書號${call}` : ''}`;
}

/** 不足 80 字时补的站名句：只说这是本站哪一类条目，不涉及条目本身的任何事实 */
const SITE_LINE: Record<string, string> = {
    work: '開源古籍索引作品條目。',
    book: '開源古籍索引版本條目。',
    collection: '開源古籍索引叢編條目。',
    entity: '開源古籍索引人物條目。',
};

/**
 * meta description（80–160 字，只用本条目自己的字段，缺什么省什么，不编造）：
 *   1. M1 的 SEO 描述已落进条目（seo.description，confidence 为 high／medium）→ 用它
 *   2. 否则按类型拼模板：
 *      作品：《书名》，又名《…》，（朝代）作者角色。卷数。存佚。部类。简介（去掉重复开头）。著录书目。版本数。相關資源
 *      版本：《书名》版本名，作者。部类。卷数。藏地索书号。简介。相關資源
 *      丛编：《书名》版本名，编者。出版。收书种数／卷册。简介。相關資源
 *      人物：名，字…号…，（朝代）籍贯人，生卒。简介。著录作品数
 *   3. 不足 80 字补一句站名；仍然为空（数据太薄）→「书名，开源古籍索引条目。」
 */
export function seoDescription(e: ItemEntry, id: string): string {
    const seo = e.seo as Json | undefined;
    if (seo && typeof seo === 'object') {
        const d = str(seo.description);
        const conf = str(seo.confidence);
        if (d && (conf === 'high' || conf === 'medium')) return clip(d);
    }
    const s = summarizeItem(e, id);
    const desc = s.description;
    const a = authorsOf(e);
    const known = [s.title, s.edition, s.measure, lossStatusText(e), ...a.names];
    let body = freshSentences(desc, known);
    let head: string[];
    let tail: string[];

    switch (s.type) {
        case 'entity': {
            const dyn = str(e.dynasty);
            const place = str(e.native_place);
            // 有籍贯：（清）海鹽人；只有朝代：清人
            const who = place ? `${dyn ? `（${dyn}）` : ''}${place}人` : dyn ? `${dyn}人` : '';
            head = [[s.title, altNamesText(e), who, lifeText(e)].filter(Boolean).join('，')];
            tail = [worksText(e)];
            break;
        }
        case 'book': {
            head = [
                [`${bookName(s.title)}${s.edition}`, a.line].filter(Boolean).join('，'),
                str(e.section) && `屬${str(e.section)}`,
                s.measure,
                provenanceText(e),
            ];
            tail = [resourcesText(e)];
            break;
        }
        case 'collection': {
            head = [
                [`${bookName(s.title)}${s.edition}`, a.line].filter(Boolean).join('，'),
                pubText(e),
                countText(e),
            ];
            tail = [resourcesText(e)];
            break;
        }
        default: {
            // 别名里混着「书名＋撰人」「书名＋按语」的著录原形，这类不当别名出
            const alts = names(e.additional_titles, 'book_title')
                .filter((t) => t !== s.title && len(t) <= 20 && !/[《》]/.test(t) && !a.names.some((n) => len(n) > 1 && t.includes(n)))
                .slice(0, 3);
            const dyn = !a.line && str(e.dynasty) ? `（${str(e.dynasty)}）` : '';
            head = [
                [`${bookName(s.title)}${dyn}`, alts.length ? `又名${alts.map(bookName).join('')}` : '', a.line]
                    .filter(Boolean).join('，'),
                s.measure,
                lossStatusText(e),
                classificationText(e),
            ];
            const books = ids(e.books).length;
            const quote = body.length ? null : indexedQuote(e, known);
            if (quote) body = quote.body;
            tail = [indexedText(e, desc, quote?.source), books ? `本站收錄其版本 ${books} 種` : '', resourcesText(e)];
        }
    }

    let text = assemble(head, body, tail);
    if (!text) return `${s.title}，开源古籍索引条目。`;
    if (len(text) < SEO_DESC_MIN) text += SITE_LINE[s.type] ?? SITE_LINE.work;
    return clip(text);
}

function itemUrl(siteUrl: string, id: string): string {
    return `${siteUrl}/item/${id}`;
}

/** additional_titles／alt_names 可能是字符串，也可能是 {book_title}／{name} 对象 */
function names(v: unknown, key: string): string[] {
    return arr(v)
        .map((x) => (typeof x === 'string' ? x.trim() : x && typeof x === 'object' ? str((x as Json)[key]) : ''))
        .filter(Boolean);
}

function ids(v: unknown, key = 'id'): string[] {
    return arr(v)
        .map((x) => (typeof x === 'string' ? x : x && typeof x === 'object' ? str((x as Json)[key]) : ''))
        .filter(isValidItemId);
}

/** 著者里的机构（出土文献多由博物馆、整理小组署名）按 Organization 出，不硬写成 Person */
const ORG_NAME = /(館|馆|局|社|院|所|會|会|組|组|中心|大學|大学|委員會|委员会|小組|小组|研究室)$/;

function agent(name: string): Json {
    return { '@type': ORG_NAME.test(name) ? 'Organization' : 'Person', name };
}

function persons(e: ItemEntry, siteUrl: string): Json[] {
    return arr(e.authors)
        .map((a) => {
            if (!a || typeof a !== 'object') return null;
            const name = str((a as Json).name);
            if (!name) return null;
            const p = agent(name);
            const eid = str((a as Json).entity_id);
            if (isValidItemId(eid)) p['@id'] = itemUrl(siteUrl, eid);
            return p;
        })
        .filter((p): p is Json => p !== null);
}

/** 去掉空值字段：数据里没有的就不出（§A.5「有才出」） */
function compact(o: Json): Json {
    const out: Json = {};
    for (const [k, v] of Object.entries(o)) {
        if (v === undefined || v === null || v === '' || v === 0) continue;
        if (Array.isArray(v) && v.length === 0) continue;
        out[k] = v;
    }
    return out;
}

function year(v: unknown): string | undefined {
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? Number(v) : NaN;
    // schema.org 的 Date 用 ISO 8601；公元前年份写成带符号的扩展年（-0145）
    if (!Number.isFinite(n) || n === 0) return undefined;
    return n < 0 ? `-${String(-n).padStart(4, '0')}` : String(n).padStart(4, '0');
}

/** 书名／版本名里写明是民族文字本的，不标 inLanguage=lzh（标错比不标糟） */
const NON_LZH = /滿文|满文|蒙古文|蒙文|藏文|西夏文|梵文|察合台|維吾爾|维吾尔/;

function language(...texts: string[]): string | undefined {
    return texts.some((t) => NON_LZH.test(t)) ? undefined : 'lzh';
}

function genre(e: ItemEntry): string | undefined {
    const c = obj(e.classification);
    const parts = [str(c.l1), str(c.l2), str(c.l3)].filter(Boolean);
    return parts.length ? parts.join('·') : str(e.section) || undefined;
}

/** 版本的成书年：只收单一年份、且不是「uncertain」的（年份区间 Date 表示不了） */
function dating(e: ItemEntry): string | undefined {
    const d = obj(e.dating);
    return str(d.certainty) === 'uncertain' ? undefined : year(d.year);
}

function publisher(e: ItemEntry): Json | undefined {
    const p = str(obj(e.publication_info).publisher);
    return p ? { '@type': 'Organization', name: p } : undefined;
}

/** 出版年：publication_info.year 是四位年份才出（「1995-2002」这类区间不出） */
function pubYear(e: ItemEntry): string | undefined {
    const y = obj(e.publication_info).year;
    return typeof y === 'number' || (typeof y === 'string' && /^\d{3,4}$/.test(y.trim())) ? year(y) : undefined;
}

function parts(site: string, list: string[], type?: string): Json[] {
    return list.slice(0, 100).map((m) => (type ? { '@type': type, '@id': itemUrl(site, m) } : { '@id': itemUrl(site, m) }));
}

/** 作品的 subtype 为单篇（诗、文、章）时不是「书」，用 CreativeWork */
const PIECE = new Set(['poem', 'article', 'chapter']);

/**
 * JSON-LD 类型与字段（schema.org）：
 *   作品 → Book（单篇 → CreativeWork）：alternateName、author、inLanguage、genre、isPartOf、workExample
 *   版本 → Book：bookEdition、exampleOfWork、author、inLanguage、genre、dateCreated、publisher、isPartOf
 *   丛编 → Collection：author、publisher、datePublished、collectionSize、isPartOf、hasPart
 *   人物 → Person（机构 → Organization）：alternateName、birthDate、deathDate
 * name、url、@id 每类都有（schema.org 无硬性必填，这三项是 Google 富结果识别实体的最低要求）。
 */
export function buildItemSeo(e: ItemEntry, id: string, siteUrl: string): ItemSeo {
    const s = summarizeItem(e, id);
    const site = siteUrl.replace(/\/$/, '');
    const url = itemUrl(site, id);
    const description = seoDescription(e, id);
    const base = { '@context': 'https://schema.org', '@id': url, name: s.title, url, description };
    const containedIn = parts(site, ids(e.contained_in), 'Collection');
    let jsonLd: Json;
    let ogType: ItemSeo['ogType'] = 'book';
    let title = s.title;

    switch (s.type) {
        case 'book': {
            if (s.edition) title = `${s.title}（${s.edition}）`;
            const work = str(e.work_id);
            jsonLd = compact({
                ...base,
                '@type': 'Book',
                alternateName: names(e.additional_titles, 'book_title'),
                bookEdition: s.edition,
                exampleOfWork: isValidItemId(work) ? { '@type': 'Book', '@id': itemUrl(site, work) } : undefined,
                author: persons(e, site),
                inLanguage: language(s.title, s.edition),
                genre: genre(e),
                dateCreated: dating(e),
                publisher: publisher(e),
                isPartOf: containedIn,
            });
            break;
        }
        case 'collection': {
            ogType = 'website';
            const members = [...ids(e.contained_works), ...ids(e.books)];
            const zhong = obj(e.count).zhong;
            if (s.edition) title = `${s.title}（${s.edition}）`;
            jsonLd = compact({
                ...base,
                '@type': 'Collection',
                alternateName: names(e.additional_titles, 'book_title'),
                author: persons(e, site),
                publisher: publisher(e),
                datePublished: pubYear(e),
                collectionSize: typeof zhong === 'number' && zhong > 0 ? zhong : members.length,
                isPartOf: containedIn,
                hasPart: parts(site, members),
            });
            break;
        }
        case 'entity': {
            ogType = 'profile';
            const dyn = str(e.dynasty);
            if (dyn) title = `${s.title}（${dyn}）`;
            const d = obj(e.dates);
            const org = str(e.subtype) === 'collective';
            jsonLd = compact({
                ...base,
                '@type': org ? 'Organization' : 'Person',
                alternateName: names(e.alt_names, 'name'),
                birthDate: org ? undefined : year(e.birth_year ?? d.birth),
                deathDate: org ? undefined : year(e.death_year ?? d.death),
            });
            break;
        }
        default: {
            // work 以及未知类型：schema.org 的 Book 可以表示抽象作品
            jsonLd = compact({
                ...base,
                '@type': PIECE.has(str(e.subtype)) ? 'CreativeWork' : 'Book',
                alternateName: names(e.additional_titles, 'book_title').filter((t) => t !== s.title),
                author: persons(e, site),
                inLanguage: language(s.title),
                genre: genre(e),
                isPartOf: containedIn,
                workExample: parts(site, ids(e.books), 'Book'),
            });
        }
    }
    return { title, description, canonicalPath: `/item/${id}`, ogType, jsonLd };
}

/** 写进 <script type="application/ld+json"> 的文本：转义 <，数据里的「</script>」不能截断脚本 */
export function jsonLdScript(jsonLd: Json): string {
    return JSON.stringify(jsonLd).replace(/</g, '\\u003c');
}
