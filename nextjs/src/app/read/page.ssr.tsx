// 阅读首页 /read（overview#267 第 16 项）：列出站上有整理本或全文的书。
//
// 文件名带 .ssr：只在全栈构建（KYG_RENDER_MODE=fullstack）里是页面；正式站静态导出看不到它。
// 数据是构建期「可读条目」索引（scripts/build-read-index.mjs，随 current/ 同步），不在请求时读 Meili。
// - 无参数：整理本、书本全文各自全部列出，下面是四部分类（与古籍总目同一套分类树与节点 id）的入口，带数量。
// - ?node=<节点>[&page=<n>]：该节点（含子孙）下的可读作品，每页 READ_PAGE_SIZE 条，有整理本的在前。
// - 参数不对、节点不存在、页码越界：真 404。
// - 这一版数据还没有阅读索引（发布中途）：首页显示「正在准备」，200，节点页 404。
// - 索引读不到（网络错、5xx）抛错走错误页，不当成 404 缓存。
// - 本页读查询串，是按请求渲染的动态页。
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getReadFeaturedServer, getReadPageServer, getReadTreeServer } from './read-data';
import { parseReadQuery, readDescription, readHomeHref, readTitle, resolveRead, type ResolvedRead } from './read-route';
import ReadHome, { type ReadHomeProps } from './ReadHome';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

interface Loaded {
    r?: ResolvedRead;
    props: ReadHomeProps;
}

async function load(sp: Record<string, string | string[] | undefined>): Promise<Loaded | null> {
    const q = parseReadQuery(sp);
    if (!q) return null;
    const tree = await getReadTreeServer();
    if (!q.node) {
        if (!tree) return { props: { tree: null } };
        const featured = (await getReadFeaturedServer()) ?? { collated: [], books: [] };
        return { props: { tree, featured } };
    }
    if (!tree) return null;
    const r = resolveRead(tree, { node: q.node, page: q.page });
    if (!r) return null;
    const cards = await getReadPageServer(r.node.id, r.page);
    // 树上有这一页、文件却没有：索引与树不同步（发布中途），按 404 处理，下一次请求会读到新版
    if (!cards) return null;
    return { r, props: { tree, current: { path: r.path, page: r.page, pageCount: r.pageCount, cards } } };
}

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
    const s = await load(await searchParams);
    if (!s) return { title: '未找到', robots: { index: false, follow: false } };
    const canonical = s.r ? readHomeHref(s.r.node.id, s.r.page) : readHomeHref();
    return {
        title: readTitle(s.r),
        description: readDescription(s.r),
        alternates: { canonical },
        openGraph: { title: readTitle(s.r), description: readDescription(s.r), url: canonical, type: 'website' },
    };
}

export default async function ReadRoute({ searchParams }: Props) {
    const s = await load(await searchParams);
    if (!s) notFound();
    return <ReadHome {...s.props} />;
}
