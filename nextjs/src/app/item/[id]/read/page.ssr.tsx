// 阅读页原来的地址 /item/<id>/read?…（N5b）→ 308 新路径式地址（overview#267 搬到 /read/<id>；overview#307 E 块改成路径式）。
//
// 整页导航由中间件先跳（只出一个 Location）；这里兜 RSC 导航与中间件放过的情况。
// 旧查询串（kind／key／juan）按该条目的 manifest 换算成新地址（lib/legacy-reader.ts）；条目没有文本就去条目页；
// 没带旧参数就是 /read/<id>。
// 本页读查询串，是按请求渲染的动态页（不能导出 generateStaticParams，见 read/[id]/[[...seg]]/page.ssr.tsx 头部的说明）。
import type { Metadata } from 'next';
import { permanentRedirect } from 'next/navigation';
import { getCurrentJsonServer } from '@/lib/server/item-data';
import { getManifest } from '@/lib/server/reader-check';
import { readerPath } from '@/lib/reader-route';
import { legacyReaderTarget, parseLegacyReaderParams } from '@/lib/legacy-reader';

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
    const legacy = parseLegacyReaderParams(id, qs);
    if (!legacy) permanentRedirect(readerPath(id));
    permanentRedirect(legacyReaderTarget(legacy, await getManifest(id, getCurrentJsonServer)) ?? `/item/${id}`);
}
