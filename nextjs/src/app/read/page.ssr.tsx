// 阅读首页 /read（overview#267 第 16 项；首页分区 overview#308）。
//
// 文件名带 .ssr：只在全栈构建（KYG_RENDER_MODE=fullstack）里是页面；正式站静态导出看不到它。
// 数据是构建期「可读条目」索引（scripts/build-read-index.mjs，随 current/ 同步），不在请求时读 Meili。
// - 无参数：首页各分区（book-index-ui 的 ReadHomeView：推荐、专题、名著与版本、四部、年代带、单篇诗文），读 read/sections.json。
// - ?node=<节点>[&page=<n>]：该节点（含子孙）下的可读作品，每页 READ_PAGE_SIZE 条。
// - ?period=<年代段>[&page=<n>]：该年代段的可读条目，每页 READ_PAGE_SIZE 条。
// - 参数不对、节点／年代段不存在、页码越界：真 404。
// - 这一版数据还没有阅读索引（发布中途）：首页显示「正在准备」，200，节点页、年代页 404。
// - 索引读不到（网络错、5xx）抛错走错误页，不当成 404 缓存。
// - 本页读查询串，是按请求渲染的动态页。
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getReadPageServer, getReadPeriodPageServer, getReadSectionsServer, getReadTreeServer } from './read-data';
import {
    parseReadQuery, readDescription, readHomeHref, readPeriodHref, readTitle, resolvePeriod, resolveRead,
    type ResolvedPeriod, type ResolvedRead,
} from './read-route';
import ReadHome, { type ReadHomeProps } from './ReadHome';
import { simplifyMetadata } from '@/lib/server/simplify';
import { getSiteT } from '@/i18n/translate';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

interface Loaded {
    r?: ResolvedRead | ResolvedPeriod;
    props: ReadHomeProps;
}

async function load(sp: Record<string, string | string[] | undefined>): Promise<Loaded | null> {
    const q = parseReadQuery(sp);
    if (!q) return null;
    if (q.period) {
        const sections = await getReadSectionsServer();
        if (!sections) return null;
        const p = resolvePeriod(sections, { period: q.period, page: q.page });
        if (!p) return null;
        const cards = await getReadPeriodPageServer(p.key, p.page);
        // 分区数据说有这一页、文件却没有：索引不同步（发布中途），按 404 处理
        if (!cards) return null;
        // 年代切换只列有条目的段（0 部的段点进去是 404）
        const periods = sections.periods.filter((x) => x.count > 0).map(({ key, label }) => ({ key, label }));
        return { r: p, props: { period: { ...p, cards, periods } } };
    }
    if (!q.node) {
        const sections = await getReadSectionsServer();
        return { props: { sections } };
    }
    const tree = await getReadTreeServer();
    if (!tree) return null;
    const r = resolveRead(tree, { node: q.node, page: q.page });
    if (!r) return null;
    const cards = await getReadPageServer(r.node.id, r.page);
    // 树上有这一页、文件却没有：索引与树不同步（发布中途），按 404 处理，下一次请求会读到新版
    if (!cards) return null;
    return { r, props: { tree, current: { path: r.path, page: r.page, pageCount: r.pageCount, cards } } };
}

function canonicalOf(r?: ResolvedRead | ResolvedPeriod): string {
    if (!r) return readHomeHref();
    if ('key' in r) return readPeriodHref(r.key, r.page);
    return readHomeHref(r.node.id, r.page);
}

async function buildMetadata({ searchParams }: Props): Promise<Metadata> {
    const s = await load(await searchParams);
    if (!s) return { title: getSiteT('zh-Hans')('seo.notFound'), robots: { index: false, follow: false } };
    const canonical = canonicalOf(s.r);
    return {
        title: readTitle(s.r),
        description: readDescription(s.r),
        alternates: { canonical },
        openGraph: { title: readTitle(s.r), description: readDescription(s.r), url: canonical, type: 'website' },
    };
}

// 服务端直出的 title／meta 一律简体：数据部分（书名、分类、回目、检索词）在这里统一转（overview#337）
export async function generateMetadata(props: Props): Promise<Metadata> {
    return simplifyMetadata(await buildMetadata(props));
}

export default async function ReadRoute({ searchParams }: Props) {
    const s = await load(await searchParams);
    if (!s) notFound();
    return <ReadHome {...s.props} />;
}
