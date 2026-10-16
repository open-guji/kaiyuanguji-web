// 精校页 /proofing/<book>/<vol>（GUJI-551）：把待审格的原叶裁图摆出来，读者对「这格是什么字」给意见，POST /api/cellreview。
// 纯客户端取数（pending.json 在 book-text 数据里，声明在章条目 pending_file）；页面本身不进索引、不做静态参数。
// 全栈构建才有这个路由（.ssr 文件，静态导出忽略）；不能放进 read/[id]/[[...seg]] 之下。
import type { Metadata } from 'next';
import ProofingClient from './ProofingClient';

export const dynamicParams = true;
export const revalidate = 300;

export function generateStaticParams() {
    return [];
}

export const metadata: Metadata = {
    title: '精校 · 开源古籍',
    robots: { index: false, follow: false },
};

type Props = { params: Promise<{ book: string; vol: string }> };

export default async function ProofingPage({ params }: Props) {
    const { book, vol } = await params;
    return <ProofingClient book={decodeURIComponent(book)} vol={decodeURIComponent(vol)} />;
}
