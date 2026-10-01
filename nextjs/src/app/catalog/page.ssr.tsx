// N4b（overview#219）：古籍总目 /catalog?node=<id>&page=<n>。
//
// 文件名带 .ssr：与条目页、阅读页一样只在全栈构建（KYG_RENDER_MODE=fullstack）里是页面；
// 正式站静态导出看不到它，产物不变，切站（#79）后随新设计一起上线。
//
// - 服务端取构建期索引（scripts/build-catalog-index.mjs 产出、随 current/ 同步）渲染首屏：
//   tree.json 定节点与页数，<node>/<page>.json 是本页 20 条作品卡。
// - 不带 node（或 node=all）时落到分类树第一个节点（經部），canonical 指向该节点页；
//   不做「全部」分页（overview#229 定）。
// - 渲染用 book-index-ui 的 CatalogPage（CatalogClient.tsx）。
// - 每个节点页各有 title 与 canonical（第 1 页不带 page）；node 不存在、page 越界或乱填真 404。
// - 索引读不到（网络错、5xx）抛错走错误页，不当成 404 缓存。
// - 本页读查询串，是按请求渲染的动态页。
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import LayoutWrapper from '@/components/layout/LayoutWrapper';
import { getCatalogPageServer, getCatalogTreeServer } from './catalog-data';
import {
    catalogDescription,
    catalogHref,
    catalogTitle,
    parseCatalogQuery,
    resolveCatalog,
} from './catalog-route';
import CatalogClient from './CatalogClient';
import { simplifyMetadata } from '@/lib/server/simplify';
import { getSiteT } from '@/i18n/translate';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

async function load(sp: Record<string, string | string[] | undefined>) {
    const q = parseCatalogQuery(sp);
    if (!q) return null;
    const tree = await getCatalogTreeServer();
    // 这一版数据还没有总目索引：与节点不存在同样处理（404），不出空壳页
    if (!tree) return null;
    const r = resolveCatalog(tree, q);
    if (!r) return null;
    return { tree, r };
}

async function buildMetadata({ searchParams }: Props): Promise<Metadata> {
    const s = await load(await searchParams);
    if (!s) return { title: getSiteT('zh-Hans')('seo.notFound'), robots: { index: false, follow: false } };
    const title = catalogTitle(s.r);
    const description = catalogDescription(s.r);
    const canonical = catalogHref(s.r.node.id, s.r.page);
    return {
        title,
        description,
        alternates: { canonical },
        openGraph: { title, description, url: canonical, type: 'website' },
    };
}

// 服务端直出的 title／meta 一律简体：数据部分（书名、分类、回目、检索词）在这里统一转（overview#337）
export async function generateMetadata(props: Props): Promise<Metadata> {
    return simplifyMetadata(await buildMetadata(props));
}

export default async function CatalogRoute({ searchParams }: Props) {
    const s = await load(await searchParams);
    if (!s) notFound();
    const { tree, r } = s;
    const works = await getCatalogPageServer(r.node.id, r.page);
    // 树上有这一页、文件却没有：索引与树不同步（发布中途），按 404 处理，下一次请求会读到新版
    if (!works) notFound();
    // 目录是分支页，与首页、元数据、阅读、关于共用页脚（用户 9-30 反馈，overview#322；取代 overview#267 的「不要页脚」）
    return (
        <LayoutWrapper>
            <CatalogClient tree={tree} selectedId={r.node.id} page={r.page} pageCount={r.pageCount} works={works} />
        </LayoutWrapper>
    );
}
