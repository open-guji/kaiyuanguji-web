import type { Metadata } from 'next';

// 页面本身是客户端页面，不能导出 metadata；canonical 放在这一层（overview#267 P2-9）。
// 之前继承根布局的 canonical「/」，搜索页被声明成首页的副本。
export const metadata: Metadata = {
  alternates: { canonical: '/book-index' },
};

export default function BookIndexLayout({ children }: { children: React.ReactNode }) {
  return children;
}
