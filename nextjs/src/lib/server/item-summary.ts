/**
 * 条目 JSON → 条目页服务端首屏要用的几行字（W2-1）。
 *
 * 只取本条目 JSON 自己有的字段（31 卡 §A.6「服务端只渲染本条目 JSON 里有的东西」），
 * 别的条目的字段（版本列表书名、人物作品表等）留给客户端详情组件去取。
 * 数据形状按实数据容错：description 可能是字符串或 {text}；juan_count 可能是
 * 数字或 {number}（spike 时直接渲染对象曾 500）。
 */
import type { ItemEntry } from './item-data';

export interface ItemSummary {
    id: string;
    type: string;
    title: string;
    /** 版本名（Book 的 edition），没有则空 */
    edition: string;
    /** 「（西漢）司馬遷撰、（南朝宋）裴駰集解」这样的一行；没有作者则空 */
    authorLine: string;
    /** 卷册篇数一行（measure_info，或由 juan_count 兜底） */
    measure: string;
    /** 简介正文 */
    description: string;
}

function str(v: unknown): string {
    return typeof v === 'string' ? v.trim() : '';
}

export function descriptionText(e: ItemEntry): string {
    const d = e.description;
    if (typeof d === 'string') return d.trim();
    if (d && typeof d === 'object') return str((d as { text?: unknown }).text);
    return '';
}

export function authorLine(e: ItemEntry): string {
    const authors = Array.isArray(e.authors) ? e.authors : [];
    return authors
        .map((a) => {
            if (!a || typeof a !== 'object') return '';
            const { name, role, dynasty } = a as { name?: unknown; role?: unknown; dynasty?: unknown };
            const n = str(name);
            if (!n) return '';
            return `${str(dynasty) ? `（${str(dynasty)}）` : ''}${n}${str(role)}`;
        })
        .filter(Boolean)
        .join('、');
}

function measureLine(e: ItemEntry): string {
    const info = str(e.measure_info);
    if (info) return info;
    const j = e.juan_count;
    const n = typeof j === 'number' ? j : (j && typeof j === 'object' ? (j as { number?: unknown }).number : undefined);
    return typeof n === 'number' && n > 0 ? `${n}卷` : '';
}

export function summarizeItem(e: ItemEntry, id: string): ItemSummary {
    const type = str(e.type);
    const title = (type === 'entity' ? str(e.primary_name) || str(e.title) : str(e.title) || str(e.name)) || id;
    return {
        id: str(e.id) || id,
        type,
        title,
        edition: str(e.edition),
        authorLine: authorLine(e),
        measure: measureLine(e),
        description: descriptionText(e),
    };
}

// ── 以下给 SEO（item-seo.ts）用：不改上面首屏摘要的任何输出 ──

/** 简介 → 纯文本：去 Markdown 粗体／标题记号，【标签】改成「标签：」，空白压成一格 */
export function plainText(s: string): string {
    return s
        .replace(/\*\*|__|`/g, '')
        .replace(/^\s*#+\s*/gm, '')
        .replace(/^\s*[-*]\s+/gm, '')
        .replace(/【([^】]{1,12})】/g, '$1：')
        .replace(/\s+/g, ' ')
        .trim();
}

/** 按句末标点（。！？）切句，标点留在句尾；引号、括号里的句号不切。「；」只是分句，不切——
 *  切了之后拼 description 时会只取枚举的一部分，读起来像少了一项 */
export function sentences(s: string): string[] {
    const out: string[] = [];
    let cur = '';
    let depth = 0;
    for (const ch of Array.from(plainText(s))) {
        cur += ch;
        if ('「『《（(“'.includes(ch)) depth++;
        else if ('」』》）)”'.includes(ch)) depth = Math.max(0, depth - 1);
        else if (depth === 0 && '。！？'.includes(ch)) {
            if (cur.trim()) out.push(cur.trim());
            cur = '';
        }
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
}

/** 存佚：只认数据里的三个值，别的（含缺）不出 */
export function lossStatusText(e: ItemEntry): string {
    const m: Record<string, string> = { extant: '今存', partially_extant: '今殘', lost: '已佚' };
    return m[str(e.loss_status)] ?? '';
}
