import { Metadata } from 'next';
import { Suspense } from 'react';
import LoginRequiredClient from './LoginRequiredClient';
import { T } from '@/i18n';

export const metadata: Metadata = {
  title: '请先登录',
  description: '需要先用邀请链接登录开源古籍网站才能继续',
  robots: { index: false, follow: false },
};

// LoginRequiredClient 用了 useSearchParams：静态导出要求包在 Suspense 里，否则构建失败
export default function LoginRequiredPage() {
  return (
    <Suspense fallback={<div className="max-w-xl mx-auto p-8 text-center"><T k="pages.loginRequired.loading" /></div>}>
      <LoginRequiredClient />
    </Suspense>
  );
}
