import LayoutWrapper from '@/components/layout/LayoutWrapper';
import { Metadata } from 'next';

interface BookDetailPageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({
  params,
}: BookDetailPageProps): Promise<Metadata> {
  const { id } = await params;
  return {
    title: `古籍详情 - ${id}`,
    description: `查看古籍《${id}》的详细信息。`,
  };
}

export default async function BookDetailPage({ params }: BookDetailPageProps) {
  const { id } = await params;

  return (
    <LayoutWrapper>
      <div className="flex flex-col items-center justify-center min-h-[60vh] px-4">
        <h1 className="text-4xl font-bold text-ink mb-4">古籍详情</h1>
        <p className="text-secondary text-lg">古籍 ID: {id}</p>
        <p className="text-secondary mt-4">详情页面即将上线</p>
      </div>
    </LayoutWrapper>
  );
}
