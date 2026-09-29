// 阅读首页 /read（overview#267 第 16 项）：列出站上有整理本或全文的书。
//
// 文件名带 .ssr：只在全栈构建（KYG_RENDER_MODE=fullstack）里是页面；正式站静态导出看不到它。
// - 无参数：整理本、书本全文各自全部列出，下面是按朝代分组的入口（带数量）。
// - ?dynasty=<朝代>[&page=<n>]：该朝代有全文的作品，每页 READ_PAGE_SIZE 条；Meili 单次最多取前 1000 条，
//   超出的朝代只能翻到前 1000 条，页尾提示改用搜索。
// - 朝代不在分组里、页码越界、参数形态不对：真 404。
// - Meili 取不到（网络错、5xx）抛错走错误页；没配置 Meili 渲染「暂时无法加载」，不 404。
// - 本页读查询串，是按请求渲染的动态页。
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getReadFetcher } from './read-data';
import { parseReadQuery, readDescription, readHomeHref, readPageCount, readTitle } from './read-route';
import ReadHome, { type ReadHomeProps } from './ReadHome';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

async function load(sp: Record<string, string | string[] | undefined>): Promise<{ q: NonNullable<ReturnType<typeof parseReadQuery>>; data: ReadHomeProps['data'] } | null> {
    const q = parseReadQuery(sp);
    if (!q) return null;
    const f = getReadFetcher();
    if (!f) return { q, data: null };
    const facet = await f.getDynastyFacet();
    if (!q.dynasty) {
        const [collated, books] = await Promise.all([f.getCollated(), f.getBooks()]);
        return { q, data: { facet, page: 1, collated, books } };
    }
    const total = facet[q.dynasty] ?? 0;
    if (total === 0 || q.page > readPageCount(total)) return null;
    const works = await f.getDynastyPage(q.dynasty, q.page);
    return { q, data: { facet, dynasty: q.dynasty, page: q.page, works } };
}

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
    const s = await load(await searchParams);
    if (!s) return { title: '未找到', robots: { index: false, follow: false } };
    const total = s.q.dynasty ? s.data?.facet[s.q.dynasty] : undefined;
    const canonical = readHomeHref(s.q.dynasty, s.q.page);
    return {
        title: readTitle(s.q),
        description: readDescription(s.q, total),
        alternates: { canonical },
        openGraph: { title: readTitle(s.q), description: readDescription(s.q, total), url: canonical, type: 'website' },
    };
}

export default async function ReadRoute({ searchParams }: Props) {
    const s = await load(await searchParams);
    if (!s) notFound();
    return <ReadHome data={s.data} />;
}
