// 精校页 /proofing/<book>/<vol>（GUJI-551）：把待审格的原叶裁图摆出来，读者对「这格是什么字」给意见，POST /api/cellreview。
// 待审数据纯客户端取（pending.json 在 book-text 数据里，声明在章条目 pending_file）；页面本身不进索引、不做静态参数。
// 服务端只取书名与作者（条目 JSON），给页头用；取不到就只显示「返回阅读」。外面套站点页头（与阅读页一样，不要页脚）。
// 全栈构建才有这个路由（.ssr 文件，静态导出忽略）；不能放进 read/[id]/[[...seg]] 之下。
import '@/lib/server/local-public-data'; // 本地联调读 public/data/（KYG_LOCAL_PUBLIC_DATA=1）；正式构建不生效
import { cache } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getItemServer } from '@/lib/server/item-data';
import { summarizeItem } from '@/lib/server/item-summary';
import ProofingClient, { type ProofingBookInfo } from './ProofingClient';

export const dynamicParams = true;
export const revalidate = 300;

export function generateStaticParams() {
    return [];
}

type Props = { params: Promise<{ book: string; vol: string }> };

const BOOK_RE = /^[A-Za-z0-9_-]{1,64}$/;

const bookInfo = cache(async (book: string): Promise<ProofingBookInfo | null> => {
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
    return {
        title: info ? `校对 · ${info.title} · 开源古籍` : '校对 · 开源古籍',
        robots: { index: false, follow: false },
    };
}

export default async function ProofingPage({ params }: Props) {
    const { book, vol } = await params;
    const b = decode(book);
    const v = decode(vol);
    if (b === null || v === null) notFound(); // 畸形 % 编码
    const info = await bookInfo(b);
    return <ProofingClient book={b} vol={v} info={info} />;
}
