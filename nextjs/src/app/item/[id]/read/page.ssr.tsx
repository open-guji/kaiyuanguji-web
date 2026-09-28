// N5b（overview#213）：阅读页 /item/<id>/read?kind=collated|fulltext[&key=…][&juan=…]。
//
// 文件名带 .ssr：与条目页一样只在全栈构建里是页面（静态导出没有动态路由），切站（#79）后上线。
// 地址约定见 lib/reader-route.ts，与 N3b 条目页的「阅读全文」共用。
//
// - 整理本渲染 CollatedEdition，全文渲染 BookFullText；直接全宽，不套页面框；标题、副题用组件默认值。
// - 每卷各有 <title> 与 canonical（按 kind、key、juan 拼，参数顺序固定）。
// - 旧入口 ?tab=fulltext／collated 的 308 在 middleware.ssr.ts。
// - 本页读查询串，是按请求渲染的动态页（不走 ISR）；正文由客户端组件挂载后取，服务端只取条目本身。
import type { Metadata } from 'next';
import { notFound, permanentRedirect, redirect } from 'next/navigation';
import { getItemServer, getPromotionServer } from '@/lib/server/item-data';
import { summarizeItem } from '@/lib/server/item-summary';
import { resolveItemRedirect } from '@/lib/server/item-redirect';
import { parseReaderQuery, readerHref, readerTitle, juanLabel, type ReaderQuery } from '@/lib/reader-route';
import ReaderClient from './ReaderClient';

export const dynamicParams = true;

export async function generateStaticParams(): Promise<{ id: string }[]> {
    return [];
}

type Props = {
    params: Promise<{ id: string }>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/** 返回 null ＝ 真 404。被并条目、草稿升格照条目页一样跳，但落到目标的阅读页 */
async function load(id: string, sp: Record<string, string | string[] | undefined>): Promise<{ q: ReaderQuery; title: string } | null> {
    const q = parseReaderQuery(id, sp);
    if (!q) return null;
    const hit = await getItemServer(id);
    const r = await resolveItemRedirect(id, hit, getPromotionServer);
    if (r) {
        const target = r.to.match(/^\/item\/([0-9a-z]+)$/)?.[1];
        (r.permanent ? permanentRedirect : redirect)(target ? readerHref(target, q) : r.to);
    }
    if (!hit) return null;
    return { q, title: summarizeItem(hit.entry, id).title };
}

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
    const { id } = await params;
    const s = await load(id, await searchParams);
    if (!s) return { title: '未找到', robots: { index: false, follow: false } };
    const title = readerTitle(s.title, s.q);
    const what = s.q.kind === 'collated' ? '整理本' : '全文';
    const description = `${s.title}${s.q.juan ? juanLabel(s.q.juan) : ''}${what}，在线阅读。`;
    const canonical = readerHref(id, s.q);
    return {
        title,
        description,
        alternates: { canonical },
        openGraph: { title, description, url: canonical, type: 'book' },
    };
}

export default async function ReaderPage({ params, searchParams }: Props) {
    const { id } = await params;
    const s = await load(id, await searchParams);
    if (!s) notFound();
    return <ReaderClient id={id} initial={s.q} bookTitle={s.title} />;
}
