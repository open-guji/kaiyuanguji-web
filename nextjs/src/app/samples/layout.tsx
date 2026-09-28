import type { Metadata } from 'next';
import { Noto_Sans_SC } from 'next/font/google';
import './samples.css';

// N1a 视觉样张（overview#92）：只在 design/n1-samples 分支，不合进 main。
// 全站黑体；整理本正文用宋体（根 layout 已加载 Noto Serif SC，变量 --font-noto-serif）。
const notoSans = Noto_Sans_SC({
  subsets: ['latin'],
  weight: ['400', '500', '700'],
  display: 'swap',
  variable: '--font-noto-sans',
});

export const metadata: Metadata = {
  title: 'N1 视觉样张',
  robots: { index: false, follow: false },
};

export default function SamplesLayout({ children }: { children: React.ReactNode }) {
  return <div className={`smp ${notoSans.variable}`}>{children}</div>;
}
