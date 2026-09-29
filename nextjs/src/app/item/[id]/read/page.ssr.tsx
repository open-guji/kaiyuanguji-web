// 阅读页原来的地址 /item/<id>/read?…（N5b）→ 308 /read/<id>?…（overview#267：阅读页改成独立的一级目录）。
//
// 整页导航由中间件先跳（只出一个 Location，还顺手把整理本旧卷号换成短形式，不跳两次）；
// 这里兜 RSC 导航与中间件放过的情况。查询参数原样带过去。
// 本页读查询串，是按请求渲染的动态页（不能导出 generateStaticParams，见 read/[id]/page.ssr.tsx 头部的说明）。
import type { Metadata } from 'next';
import { permanentRedirect } from 'next/navigation';
import { readerPath } from '@/lib/reader-route';

export const dynamic = 'force-dynamic';

type Props = {
    params: Promise<{ id: string }>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata(): Promise<Metadata> {
    return { robots: { index: false, follow: false } };
}

export default async function LegacyReaderPage({ params, searchParams }: Props) {
    const { id } = await params;
    const sp = await searchParams;
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) {
        for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) qs.append(k, x);
    }
    const s = qs.toString();
    permanentRedirect(`${readerPath(id)}${s ? `?${s}` : ''}`);
}
