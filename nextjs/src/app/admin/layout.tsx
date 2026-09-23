import type { Metadata } from 'next';
import AdminNav from './AdminNav';
import AdminGuard from './AdminGuard';

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <AdminGuard>
      <div className="min-h-screen bg-gray-50">
        <header className="bg-white border-b sticky top-0 z-10">
          <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
            <span className="font-semibold">管理后台</span>
            <span className="text-xs text-gray-400">仅 admin 可见 · 不在公网导航中出现</span>
          </div>
        </header>
        <div className="max-w-6xl mx-auto px-4 py-6 flex gap-6">
          <AdminNav />
          <main className="flex-1 min-w-0">{children}</main>
        </div>
      </div>
    </AdminGuard>
  );
}
