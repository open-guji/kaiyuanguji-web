import LayoutWrapper from '@/components/layout/LayoutWrapper';
import { Metadata } from 'next';

export const metadata: Metadata = {
  title: '古籍索引',
  description: '浏览和搜索开源古籍数据库，发现传统文化的宝藏。',
};

export default function BookIndexPage() {
  return (
    <LayoutWrapper>
      <div className="flex flex-col items-center justify-center min-h-[60vh] px-4">
        <h1 className="text-4xl font-bold text-ink mb-4">古籍索引</h1>
        <p className="text-secondary text-lg">古籍索引功能即将上线</p>
      </div>
    </LayoutWrapper>
  );
}
