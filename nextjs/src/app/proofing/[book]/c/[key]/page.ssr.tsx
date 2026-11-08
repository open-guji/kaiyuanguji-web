// 跨册聚类审核 /proofing/<book>/c/<聚类键>：同一原因、同一个字的待选格跨册排在一起成批确认（键 `<原因>~<字>`，如 lib_missing~兀）。
// 数据纯客户端取（summary.json 找出这个聚类涉及哪几册，再逐册取各自的待审单）；页面本身不进索引、不做静态参数。
// 全栈构建才有这个路由（.ssr 文件，静态导出忽略）。
import '@/lib/server/local-public-data'; // 本地联调读 public/data/（KYG_LOCAL_PUBLIC_DATA=1）；正式构建不生效
import { cache } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getItemServer } from '@/lib/server/item-data';
import { summarizeItem } from '@/lib/server/item-summary';
import ClusterClient from './ClusterClient';
import type { ProofBookInfo } from '@/components/proof/ProofHeader';

export const dynamicParams = true;
export const revalidate = 300;

export function generateStaticParams() {
    return [];
}

type Props = { params: Promise<{ book: string; key: string }> };
const BOOK_RE = /^[A-Za-z0-9_-]{1,64}$/;

const bookInfo = cache(async (book: string): Promise<ProofBookInfo | null> => {
    if (!BOOK_RE.test(book)) return null;
    try {
        const hit = await getItemServer(book, { prefer: 'current' });
        if (!hit) return null;
        const s = summarizeItem(hit.entry, book);
        return { title: s.title, author: s.authorLine || undefined };
    } catch {
        return null;
    }
});

function decode(s: string): string | null {
    try { return decodeURIComponent(s); } catch { return null; }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
    const { book } = await params;
    const b = decode(book);
    const info = b ? await bookInfo(b) : null;
    return { title: info ? `成批校对 · ${info.title} · 开源古籍` : '成批校对 · 开源古籍', robots: { index: false, follow: false } };
}

export default async function ProofingClusterPage({ params }: Props) {
    const { book, key } = await params;
    const b = decode(book);
    const k = decode(key);
    if (b === null || k === null) notFound();
    return <ClusterClient book={b} clusterKey={k} info={await bookInfo(b)} />;
}
