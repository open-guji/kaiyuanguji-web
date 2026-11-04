// 全书校对总览 /proofing/<book>：这本书一共还有多少待选格、都是什么原因、每册各有多少，以及可以成批审的聚类入口。
// 数据纯客户端取（proof/<书>/summary.json，每日 proofing-sync 生成）；页面本身不进索引、不做静态参数。
// 全栈构建才有这个路由（.ssr 文件，静态导出忽略）。
import '@/lib/server/local-public-data'; // 本地联调读 public/data/（KYG_LOCAL_PUBLIC_DATA=1）；正式构建不生效
import { cache } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getItemServer } from '@/lib/server/item-data';
import { summarizeItem } from '@/lib/server/item-summary';
import BookOverviewClient from './BookOverviewClient';
import type { ProofBookInfo } from '@/components/proof/ProofHeader';

export const dynamicParams = true;
export const revalidate = 300;

export function generateStaticParams() {
    return [];
}

type Props = { params: Promise<{ book: string }> };
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
    return { title: info ? `校对总览 · ${info.title} · 开源古籍` : '校对总览 · 开源古籍', robots: { index: false, follow: false } };
}

export default async function ProofingBookPage({ params }: Props) {
    const { book } = await params;
    const b = decode(book);
    if (b === null) notFound();
    return <BookOverviewClient book={b} info={await bookInfo(b)} />;
}
