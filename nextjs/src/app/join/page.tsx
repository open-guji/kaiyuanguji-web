import { Metadata } from 'next';
import { Suspense } from 'react';
import JoinClient from './JoinClient';
import { T } from '@/i18n';

export const metadata: Metadata = {
  title: '加入协作',
  description: '通过邀请链接加入开放古籍协作',
  // 链接里带邀请码，不进搜索引擎
  robots: { index: false, follow: false },
};

// JoinClient 用了 useSearchParams：静态导出要求包在 Suspense 里，否则构建失败
export default function JoinPage() {
  return (
    <Suspense fallback={<div className="max-w-xl mx-auto p-8 text-center"><T k="pages.join.loading" /></div>}>
      <JoinClient />
    </Suspense>
  );
}
