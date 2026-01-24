import LayoutWrapper from '@/components/layout/LayoutWrapper';

export default function HomePage() {
  return (
    <LayoutWrapper>
      <div className="flex flex-col items-center justify-center min-h-[60vh] px-4">
        <h1 className="text-4xl font-bold text-vermilion mb-4">开源古籍</h1>
        <p className="text-secondary text-lg">让古籍数字化更简单</p>
        <p className="text-secondary mt-8">Next.js 版本正在开发中...</p>
      </div>
    </LayoutWrapper>
  );
}
