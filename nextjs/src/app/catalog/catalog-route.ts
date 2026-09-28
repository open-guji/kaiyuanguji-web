/**
 * 古籍总目 /catalog?node=<id>&page=<n> 的地址约定（N4b，overview#219）。纯函数，页面与测试共用。
 *
 * 数据契约与 book-index-manager 的总目组件（N4a，overview#218 第 4 条）一致；
 * 构建期产物见 scripts/build-catalog-index.mjs：
 *   catalog/tree.json               CatalogNode[]
 *   catalog/<nodeId>/<page>.json    CatalogWorkCard[]，每页 CATALOG_PAGE_SIZE 条
 */

export interface CatalogNode {
    id: string;
    label: string;
    count: number;
    children?: CatalogNode[];
}

export interface CatalogWorkCard {
    id: string;
    title: string;
    /** 数字按「N卷」显示，字符串原样显示（与 book-index-ui 0.10.1 的 CatalogWorkCard 一致） */
    juan?: number | string;
    authors?: { name: string; dynasty?: string }[];
    summary?: string;
    classification?: string[];
}

/** 与 build-catalog-index.mjs 的 CATALOG_PAGE_SIZE 一致 */
export const CATALOG_PAGE_SIZE = 20;
export const CATALOG_PATH = '/catalog';
/**
 * 组件的「全部」行（book-index-ui 的 CATALOG_ALL_ID）。「全部」怎么呈现待用户定（overview#229），
 * 定之前 node=all 与不带 node 一样落到默认节点，不出 404。这里不 import 组件包：本文件服务端也用。
 */
export const CATALOG_ALL_ID = 'all';

/** 节点 id 形态：构建脚本出的 c+10 位 hex，或 unclassified。挡掉路径穿越 */
export function isValidNodeId(id: string): boolean {
    return /^[0-9a-z]{1,24}$/.test(id);
}

export function pageCountOf(count: number): number {
    return Math.max(1, Math.ceil(count / CATALOG_PAGE_SIZE));
}

/** 按 id 找节点，连同从根到它的路径（含它自己） */
export function findNode(tree: CatalogNode[], id: string): CatalogNode[] | null {
    for (const n of tree) {
        if (n.id === id) return [n];
        if (n.children) {
            const sub = findNode(n.children, id);
            if (sub) return [n, ...sub];
        }
    }
    return null;
}

function one(v: string | string[] | undefined): string | undefined {
    return Array.isArray(v) ? v[0] : v;
}

export interface CatalogQuery {
    /** 查询串里的 node；没给或为 all 时是 undefined（落到第一个节点） */
    node?: string;
    page: number;
}

/** 解析查询串。形态不对（node 乱码、page 不是正整数）返回 null ＝ 404 */
export function parseCatalogQuery(sp: Record<string, string | string[] | undefined>): CatalogQuery | null {
    const rawNode = one(sp.node);
    const node = rawNode === CATALOG_ALL_ID ? undefined : rawNode;
    const rawPage = one(sp.page);
    if (node !== undefined && !isValidNodeId(node)) return null;
    let page = 1;
    if (rawPage !== undefined) {
        if (!/^[1-9][0-9]{0,5}$/.test(rawPage)) return null;
        page = Number(rawPage);
    }
    return { node, page };
}

export interface ResolvedCatalog {
    /** 从根到当前节点 */
    path: CatalogNode[];
    node: CatalogNode;
    page: number;
    pageCount: number;
}

/** 对着分类树落实节点与页码；节点不存在或页码越界返回 null ＝ 404 */
export function resolveCatalog(tree: CatalogNode[], q: CatalogQuery): ResolvedCatalog | null {
    const path = q.node === undefined ? (tree[0] ? [tree[0]] : null) : findNode(tree, q.node);
    if (!path) return null;
    const node = path[path.length - 1];
    const pageCount = pageCountOf(node.count);
    if (q.page > pageCount) return null;
    return { path, node, page: q.page, pageCount };
}

/** 节点页地址（第 1 页不带 page）；也是 canonical */
export function catalogHref(nodeId: string, page = 1): string {
    return `${CATALOG_PATH}?node=${encodeURIComponent(nodeId)}${page > 1 ? `&page=${page}` : ''}`;
}

/** 页面标题（不含站名，站名由根布局的 title.template 加） */
export function catalogTitle(r: ResolvedCatalog): string {
    const trail = r.path.map((n) => n.label).join('·');
    return `${trail}${r.page > 1 ? `（第${r.page}页）` : ''} - 古籍总目`;
}

export function catalogDescription(r: ResolvedCatalog): string {
    const trail = r.path.map((n) => n.label).join(' › ');
    return `古籍总目 ${trail}：共 ${r.node.count} 部作品${r.pageCount > 1 ? `，第 ${r.page}／${r.pageCount} 页` : ''}。`;
}

/** 条目页地址（与 N3b 条目页一致） */
export function workHref(id: string): string {
    return `/item/${encodeURIComponent(id)}`;
}
