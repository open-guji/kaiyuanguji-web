import type { Metadata } from 'next';
import { searchPageTitle } from '@/lib/search-title';
import BookIndexClient from './BookIndexClient';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

// 搜索页 title 带检索词（overview#267 P2-9）。
// 在服务端出：客户端 effect 里改 document.title 会被 React 提升到 <head> 的 <title> 在水合后盖回去
// （测试站 verify 实测：title 一直是「开源古籍」）。带 id 的是条目详情视图（旧地址），不动 title。
// 静态导出（output: 'export'，不设 KYG_RENDER_MODE）读 searchParams 会让构建失败，那种构建下不带检索词，用默认 title。
export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  if (process.env.KYG_RENDER_MODE !== 'fullstack' && process.env.NEXT_PUBLIC_MODE !== 'local') return {};
  const sp = await searchParams;
  if (sp.id) return {};
  const title = searchPageTitle(sp.q);
  return title ? { title } : {};
}

export default function BookIndexPage() {
  return <BookIndexClient />;
}
