import { Metadata } from 'next';
import { Suspense } from 'react';
import RegisterClient from './RegisterClient';

export const metadata: Metadata = {
  title: '登录／注册',
  description: '用邮箱登录开源古籍',
  robots: { index: false, follow: false },
};

export default function RegisterPage() {
  return (
    <Suspense fallback={<div className="max-w-xl mx-auto p-8 text-center">加载中…</div>}>
      <RegisterClient />
    </Suspense>
  );
}
