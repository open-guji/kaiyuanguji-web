import { Suspense } from 'react';
import { TextTabs } from './TextNav';

export default function AdminTextLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-5">
      {/* useSearchParams：静态导出要求包在 Suspense 里 */}
      <Suspense fallback={null}><TextTabs /></Suspense>
      {children}
    </div>
  );
}
