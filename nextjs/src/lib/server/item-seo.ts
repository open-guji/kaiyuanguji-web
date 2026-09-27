/**
 * 条目页头部与结构化数据（W2-2，31 卡 §A.5 字段表）。
 *
 * 只用本条目 JSON 自己有的字段（§A.6「服务端只渲染本条目 JSON 里有的东西」），
 * 这样「哪些页要清缓存」恰好等于「哪些条目变了」。别的条目的页面只以 URL 引用
 * （workExample、exampleOfWork、isPartOf、hasPart、author.@id），不取它们的字段。
 * JSON-LD 不从 ai_note 等内部字段取；description 与 meta description 同源。
 */
import type { ItemEntry } from './item-data';
import { summarizeItem, descriptionText, authorLine } from './item-summary';
import { isValidItemId } from '../item-id';

export const SEO_DESC_MAX = 120;

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

/**
 * meta description：
 *   1. M1 的 SEO 描述已落进条目（seo.description，confidence 为 high／medium）→ 用它
 *   2. 否则按类型拼模板（只用本条目自己的字段）：
 *      作品「（朝代）作者角色 · 卷册 · 简介」；版本、丛编前面加版本名；
 *      人物「（朝代）籍贯人。简介」，没有简介时补「著录作品 N 部」
 *   3. 仍然为空（数据太薄）→「书名，开源古籍索引条目。」——description 不出空
 * 一律截 120 字。
 */
export function seoDescription(e: ItemEntry, id: string): string {
    const seo = e.seo as Json | undefined;
    if (seo && typeof seo === 'object') {
        const d = str(seo.description);
        const conf = str(seo.confidence);
        if (d && (conf === 'high' || conf === 'medium')) return clip(d);
    }
    const s = summarizeItem(e, id);
    let text: string;
    if (s.type === 'entity') {
        const dyn = str(e.dynasty);
        const place = str(e.native_place);
        const who = dyn || place ? `${dyn ? `（${dyn}）` : ''}${place}人。` : '';
        const works = arr(e.works).length;
        text = `${who}${s.description || (works ? `著录作品 ${works} 部。` : '')}`;
    } else {
        const edition = s.type === 'book' || s.type === 'collection' ? s.edition : '';
        text = [edition, s.authorLine, s.measure, s.description].filter(Boolean).join(' · ');
    }
    return clip(text || `${s.title}，开源古籍索引条目。`);
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

function persons(e: ItemEntry, siteUrl: string): Json[] {
    return arr(e.authors)
        .map((a) => {
            if (!a || typeof a !== 'object') return null;
            const name = str((a as Json).name);
            if (!name) return null;
            const p: Json = { '@type': 'Person', name };
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
        if (v === undefined || v === null || v === '') continue;
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

export function buildItemSeo(e: ItemEntry, id: string, siteUrl: string): ItemSeo {
    const s = summarizeItem(e, id);
    const site = siteUrl.replace(/\/$/, '');
    const url = itemUrl(site, id);
    const description = seoDescription(e, id);
    const base = { '@context': 'https://schema.org', name: s.title, url, description };
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
                bookEdition: s.edition,
                exampleOfWork: isValidItemId(work) ? { '@type': 'Book', '@id': itemUrl(site, work) } : undefined,
                author: persons(e, site),
                isPartOf: ids(e.contained_in).map((c) => ({ '@type': 'Collection', '@id': itemUrl(site, c) })),
                inLanguage: 'lzh',
            });
            break;
        }
        case 'collection': {
            ogType = 'website';
            const members = [...ids(e.contained_works), ...ids(e.books)];
            if (s.edition) title = `${s.title}（${s.edition}）`;
            jsonLd = compact({
                ...base,
                '@type': 'Collection',
                author: persons(e, site),
                isPartOf: ids(e.contained_in).map((c) => ({ '@type': 'Collection', '@id': itemUrl(site, c) })),
                hasPart: members.slice(0, 100).map((m) => ({ '@id': itemUrl(site, m) })),
            });
            break;
        }
        case 'entity': {
            ogType = 'profile';
            const dyn = str(e.dynasty);
            if (dyn) title = `${s.title}（${dyn}）`;
            jsonLd = compact({
                ...base,
                '@type': 'Person',
                alternateName: names(e.alt_names, 'name'),
                birthDate: year(e.birth_year),
                deathDate: year(e.death_year),
            });
            break;
        }
        default: {
            // work 以及未知类型：schema.org 的 Book 可以表示抽象作品
            jsonLd = compact({
                ...base,
                '@type': 'Book',
                alternateName: names(e.additional_titles, 'book_title'),
                author: persons(e, site),
                inLanguage: 'lzh',
                workExample: ids(e.books).slice(0, 100).map((b) => ({ '@type': 'Book', '@id': itemUrl(site, b) })),
            });
        }
    }
    return { title, description, canonicalPath: `/item/${id}`, ogType, jsonLd };
}

/** 写进 <script type="application/ld+json"> 的文本：转义 <，数据里的「</script>」不能截断脚本 */
export function jsonLdScript(jsonLd: Json): string {
    return JSON.stringify(jsonLd).replace(/</g, '\\u003c');
}
