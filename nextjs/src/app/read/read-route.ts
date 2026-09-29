/**
 * 阅读首页 /read?node=<节点>&page=<n> 的地址约定与纯函数（overview#267 第 16 项）。页面与测试共用。
 *
 * 数据是构建期「可读条目」索引（scripts/build-read-index.mjs，随 current/ 同步）：
 *   read/featured.json            { collated: ReadCard[], books: ReadCard[] }  首页整份列出
 *   read/tree.json                CatalogNode[]  与古籍总目同一套分类树与节点 id（只计可读的 Work）
 *   read/<nodeId>/<page>.json     ReadCard[]     每页 READ_PAGE_SIZE 条，有整理本的在前
 * 不带 node ＝ 首页（精选＋四部入口）；带 node ＝ 该节点（含子孙）的作品分页。
 */
import { findNode, isValidNodeId, type CatalogNode } from '../catalog/catalog-route';

export type { CatalogNode };

export const READ_PATH = '/read';
/** 与 build-read-index.mjs 的 READ_PAGE_SIZE 一致 */
export const READ_PAGE_SIZE = 20;

export interface ReadCard {
    id: string;
    title: string;
    juan?: number | string;
    authors?: { name: string; dynasty?: string }[];
    /** 有整理本 */
    collated?: true;
    classification?: string[];
}

export interface ReadFeatured {
    collated: ReadCard[];
    books: ReadCard[];
}

export interface ReadQuery {
    node?: string;
    page: number;
}

function one(v: string | string[] | undefined): string | undefined {
    return Array.isArray(v) ? v[0] : v;
}

/** 解析查询串；形态不对返回 null ＝ 404 */
export function parseReadQuery(sp: Record<string, string | string[] | undefined>): ReadQuery | null {
    const node = one(sp.node);
    if (node !== undefined && !isValidNodeId(node)) return null;
    const rawPage = one(sp.page);
    let page = 1;
    if (rawPage !== undefined) {
        if (!/^[1-9][0-9]{0,5}$/.test(rawPage)) return null;
        page = Number(rawPage);
    }
    if (page > 1 && node === undefined) return null;
    return { node, page };
}

export function readPageCount(count: number): number {
    return Math.max(1, Math.ceil(count / READ_PAGE_SIZE));
}

export interface ResolvedRead {
    /** 从根到当前节点 */
    path: CatalogNode[];
    node: CatalogNode;
    page: number;
    pageCount: number;
}

/** 对着分类树落实节点与页码；节点不存在或页码越界返回 null ＝ 404 */
export function resolveRead(tree: CatalogNode[], q: { node: string; page: number }): ResolvedRead | null {
    const path = findNode(tree, q.node);
    if (!path) return null;
    const node = path[path.length - 1];
    const pageCount = readPageCount(node.count);
    if (q.page > pageCount) return null;
    return { path, node, page: q.page, pageCount };
}

/** 首页与节点页地址（第 1 页不带 page）；也是 canonical */
export function readHomeHref(nodeId?: string, page = 1): string {
    if (!nodeId) return READ_PATH;
    return `${READ_PATH}?node=${encodeURIComponent(nodeId)}${page > 1 ? `&page=${page}` : ''}`;
}

/** 卡片的阅读地址：有整理本读整理本，否则读全文（Work 不带 key，由阅读器取首选那份；Book 只有全文） */
export function readCardHref(c: Pick<ReadCard, 'id' | 'collated'>): string {
    return `/read/${c.id}?kind=${c.collated ? 'collated' : 'fulltext'}`;
}

export function readTitle(r?: ResolvedRead): string {
    if (!r) return '阅读';
    const trail = r.path.map((n) => n.label).join('·');
    return `${trail}${r.page > 1 ? `（第${r.page}页）` : ''} - 阅读`;
}

export function readDescription(r?: ResolvedRead): string {
    if (!r) return '开源古籍阅读首页：列出站上所有有整理本或全文的古籍，按经史子集分类，可直接阅读。';
    const trail = r.path.map((n) => n.label).join(' › ');
    return `${trail}中可直接阅读的作品，共 ${r.node.count} 部${r.pageCount > 1 ? `，第 ${r.page}／${r.pageCount} 页` : ''}。`;
}
