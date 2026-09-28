import type { Metadata } from 'next';
import './n6.css';

// N6 样张（overview#259）：首页与页脚的「关于我们」「联系我们」、二维码。
// 只在 design/n6-samples 分支，不合进 main；批了以后按选定方案改正式页面。
export const metadata: Metadata = {
  title: 'N6 样张 · 关于与联系',
  robots: { index: false, follow: false },
};

export default function N6SamplesLayout({ children }: { children: React.ReactNode }) {
  return <div className="n6">{children}</div>;
}
