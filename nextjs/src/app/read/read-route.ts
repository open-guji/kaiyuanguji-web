/**
 * 阅读首页 /read、/read?node=<节点>&page=<n>、/read?period=<年代段>&page=<n> 的地址约定与纯函数
 * （overview#267 第 16 项、#308）。页面与测试共用。
 *
 * 数据是构建期「可读条目」索引（scripts/build-read-index.mjs，随 current/ 同步）：
 *   read/sections.json              ReadSections   首页各分区（推荐、专题、名著与版本、四部、年代带、单篇诗文）
 *   read/tree.json                  CatalogNode[]  与古籍总目同一套分类树与节点 id（只计可读的 Work）
 *   read/<nodeId>/<page>.json       ReadCard[]     每页 READ_PAGE_SIZE 条
 *   read/period/<key>/<page>.json   ReadCard[]     某年代段的可读条目，每页 READ_PAGE_SIZE 条
 * 不带参数＝首页；带 node＝该节点（含子孙）的作品分页；带 period＝该年代段的分页。node 与 period 不能同时给。
 */
import { findNode, isValidNodeId, type CatalogNode } from '../catalog/catalog-route';
import { readerPath } from '@/lib/reader-route';
import type { ReadSections } from 'book-index-ui';
import { getSiteT } from '@/i18n/translate';

export type { CatalogNode, ReadSections };

/** 年代段（与 build-read-index.mjs 的 READ_PERIODS 同序同 key） */
export const READ_PERIODS: { key: string; label: string }[] = [
    { key: 'xianqin', label: '先秦' },
    { key: 'qinhan', label: '秦漢' },
    { key: 'weijin', label: '魏晉南北朝' },
    { key: 'suitang', label: '隋唐五代' },
    { key: 'song', label: '宋' },
    { key: 'liaojinyuan', label: '遼金元' },
    { key: 'ming', label: '明' },
    { key: 'qing', label: '清' },
    { key: 'modern', label: '近現代' },
];
const PERIOD_KEYS = new Set(READ_PERIODS.map((p) => p.key));

export const READ_PATH = '/read';
/** 与 build-read-index.mjs 的 READ_PAGE_SIZE 一致 */
export const READ_PAGE_SIZE = 20;

export interface ReadCard {
    id: string;
    title: string;
    /** 版本名（Book 的 edition）：同名书靠它分辨 */
    edition?: string;
    juan?: number | string;
    authors?: { name: string; dynasty?: string }[];
    /** 有整理本（只用于排序，页面上不显示） */
    collated?: true;
    classification?: string[];
    /** 年代段 key */
    period?: string;
    /** 作品子类：article／poem／chapter；书不写 */
    subtype?: string;
    /** 站内文本数（作品自身版本＋同 work_id 的 Book） */
    text_count?: number;
    work_id?: string;
}

export interface ReadQuery {
    node?: string;
    period?: string;
    page: number;
}

function one(v: string | string[] | undefined): string | undefined {
    return Array.isArray(v) ? v[0] : v;
}

/** 解析查询串；形态不对返回 null ＝ 404 */
export function parseReadQuery(sp: Record<string, string | string[] | undefined>): ReadQuery | null {
    const node = one(sp.node);
    if (node !== undefined && !isValidNodeId(node)) return null;
    const period = one(sp.period);
    if (period !== undefined && !PERIOD_KEYS.has(period)) return null;
    if (node !== undefined && period !== undefined) return null;
    const rawPage = one(sp.page);
    let page = 1;
    if (rawPage !== undefined) {
        if (!/^[1-9][0-9]{0,5}$/.test(rawPage)) return null;
        page = Number(rawPage);
    }
    if (page > 1 && node === undefined && period === undefined) return null;
    return { node, period, page };
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

export interface ResolvedPeriod {
    key: string;
    label: string;
    count: number;
    page: number;
    pageCount: number;
}

/** 对着首页分区数据落实年代段与页码；该段没有条目或页码越界返回 null ＝ 404 */
export function resolvePeriod(sections: Pick<ReadSections, 'periods'>, q: { period: string; page: number }): ResolvedPeriod | null {
    const p = sections.periods.find((x) => x.key === q.period);
    if (!p || p.count <= 0) return null;
    const pageCount = readPageCount(p.count);
    if (q.page > pageCount) return null;
    const label = p.label || READ_PERIODS.find((x) => x.key === q.period)?.label || q.period;
    return { key: p.key, label, count: p.count, page: q.page, pageCount };
}

/** 年代分页地址（第 1 页不带 page）；也是 canonical */
export function readPeriodHref(key: string, page = 1): string {
    return `${READ_PATH}?period=${encodeURIComponent(key)}${page > 1 ? `&page=${page}` : ''}`;
}

/** 首页与节点页地址（第 1 页不带 page）；也是 canonical */
export function readHomeHref(nodeId?: string, page = 1): string {
    if (!nodeId) return READ_PATH;
    return `${READ_PATH}?node=${encodeURIComponent(nodeId)}${page > 1 ? `&page=${page}` : ''}`;
}

/** 卡片的阅读地址：主版本（default，按来源优先级排出：整理本 → 維基文庫 → Kanripo）的第一章，路径式（overview#307） */
export function readCardHref(c: Pick<ReadCard, 'id'>): string {
    return readerPath(c.id);
}

export function readTitle(r?: ResolvedRead | ResolvedPeriod): string {
    const t = getSiteT('zh-Hans');
    if (!r) return t('seo.readHomeTitle');
    const page = r.page > 1 ? t('seo.pageSuffix', { n: r.page }) : '';
    if ('key' in r) return t('seo.readTitle', { trail: r.label, page });
    return t('seo.readTitle', { trail: r.path.map((n) => n.label).join('·'), page });
}

export function readDescription(r?: ResolvedRead | ResolvedPeriod): string {
    const t = getSiteT('zh-Hans');
    if (!r) return t('seo.readHomeDescription');
    const page = r.pageCount > 1 ? t('seo.pageOf', { page: r.page, total: r.pageCount }) : '';
    if ('key' in r) return t('seo.readPeriodDescription', { label: r.label, count: r.count, page });
    return t('seo.readNodeDescription', { trail: r.path.map((n) => n.label).join(' › '), count: r.node.count, page });
}
