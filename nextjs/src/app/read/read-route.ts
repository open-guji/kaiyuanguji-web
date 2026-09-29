/**
 * 阅读首页 /read?dynasty=<朝代>&page=<n> 的地址约定与纯函数（overview#267 第 16 项）。页面与测试共用。
 *
 * 数据口径：站上「有整理本或全文」的条目——Work 的 has_collated / has_text，Book 的 has_text。
 * 取自 Meili 索引（GET，只读）。Meili 单次查询最多取前 1000 条（offset ≥ 1000 返回空），
 * 所以全文作品按朝代分组翻页，每个朝代最多翻到前 1000 条（READ_MAX_HITS）。
 */

export const READ_PATH = '/read';
export const READ_PAGE_SIZE = 30;
/** Meili 的 maxTotalHits：offset+limit 超过它就没有结果 */
export const READ_MAX_HITS = 1000;

export interface ReadCard {
    id: string;
    title: string;
    author?: string;
    dynasty?: string;
    juanCount?: number;
    hasCollated: boolean;
    hasText: boolean;
}

export interface ReadQuery {
    dynasty?: string;
    page: number;
}

/** 朝代大致先后；不在表里的排在后面，按条目数从多到少 */
export const DYNASTY_ORDER = [
    '上古', '商', '西周', '周', '春秋', '戰國', '先秦', '秦', '西漢', '漢', '東漢', '三國', '西晉', '晉', '東晉',
    '南朝宋', '南朝齊', '南朝梁', '南朝陳', '北魏', '北齊', '北周', '隋', '唐', '五代', '北宋', '南宋', '宋', '遼', '金', '元', '明', '清',
];

function one(v: string | string[] | undefined): string | undefined {
    return Array.isArray(v) ? v[0] : v;
}

/** 朝代名只允许中日韩汉字（含「後」「戰」等繁体），最长 8 字；挡掉注入到 Meili filter 的字符 */
export function isValidDynasty(s: string): boolean {
    return /^[㐀-鿿]{1,8}$/.test(s);
}

/** 解析查询串；形态不对返回 null ＝ 404 */
export function parseReadQuery(sp: Record<string, string | string[] | undefined>): ReadQuery | null {
    const dynasty = one(sp.dynasty);
    if (dynasty !== undefined && !isValidDynasty(dynasty)) return null;
    const rawPage = one(sp.page);
    let page = 1;
    if (rawPage !== undefined) {
        if (!/^[1-9][0-9]{0,3}$/.test(rawPage)) return null;
        page = Number(rawPage);
    }
    if (page > 1 && dynasty === undefined) return null;
    return { dynasty, page };
}

export function readHomeHref(dynasty?: string, page = 1): string {
    if (!dynasty) return READ_PATH;
    return `${READ_PATH}?dynasty=${encodeURIComponent(dynasty)}${page > 1 ? `&page=${page}` : ''}`;
}

/** 某朝代可翻的页数：受 Meili 1000 条上限限制 */
export function readPageCount(count: number): number {
    return Math.max(1, Math.ceil(Math.min(count, READ_MAX_HITS) / READ_PAGE_SIZE));
}

/** 该朝代条目数超出可翻上限 */
export function isTruncated(count: number): boolean {
    return count > READ_MAX_HITS;
}

/** 按 DYNASTY_ORDER 排；表外的靠后、按数量降序 */
export function sortDynasties(facet: Record<string, number>): { name: string; count: number }[] {
    const rank = (n: string) => {
        const i = DYNASTY_ORDER.indexOf(n);
        return i < 0 ? DYNASTY_ORDER.length : i;
    };
    return Object.entries(facet)
        .filter(([name, count]) => name && count > 0)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => rank(a.name) - rank(b.name) || b.count - a.count || a.name.localeCompare(b.name));
}

/** 卡片的阅读地址：有整理本读整理本，否则读全文（Work 不带 key，由阅读器取首选那份） */
export function readCardHref(c: Pick<ReadCard, 'id' | 'hasCollated'>): string {
    return `/read/${c.id}?kind=${c.hasCollated ? 'collated' : 'fulltext'}`;
}

export function readTitle(q: ReadQuery): string {
    if (!q.dynasty) return '阅读';
    return `${q.dynasty}代作品${q.page > 1 ? `（第${q.page}页）` : ''} - 阅读`;
}

export function readDescription(q: ReadQuery, total?: number): string {
    if (!q.dynasty) return '开源古籍阅读首页：列出站上所有有整理本或全文的古籍，可直接阅读。';
    return `${q.dynasty}朝古籍中可直接阅读的作品${total ? `，共 ${total} 部` : ''}。`;
}
