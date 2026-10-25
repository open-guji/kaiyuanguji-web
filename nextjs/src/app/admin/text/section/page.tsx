import { Suspense } from 'react';
import SectionView from '../SectionView';

export const metadata = { robots: { index: false, follow: false } };

export default function AdminTextSectionPage() {
  // SectionView 用了 useSearchParams（?s=栏目）：静态导出要求包在 Suspense 里
  return <Suspense fallback={null}><SectionView /></Suspense>;
}
