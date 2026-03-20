import { Suspense } from 'react';
import { Metadata } from 'next';
import { getTransport } from '@/lib/transport';
import BookDetailContent from '@/components/book-index/BookDetailContent';

interface BookDetailPageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({
  params,
}: BookDetailPageProps): Promise<Metadata> {
  const { id } = await params;

  try {
    const transport = getTransport('github');
    const entry = await transport.getEntry(id);
    const title = entry ? `${entry.title} - 古籍详情` : `古籍详情 - ${id}`;
    const description = entry ? `查看古籍《${entry.title}》的详细信息。` : `查看古籍 ${id} 的详细信息。`;

    return {
      title,
      description,
      alternates: {
        canonical: `/book-index/${id}`,
      },
    };
  } catch {
    return { title: '古籍详情' };
  }
}

export async function generateStaticParams() {
  try {
    const transport = getTransport('github');
    const allEntries = await transport.getAllEntries();
    const params = allEntries.map((entry) => ({
      id: entry.id,
    }));

    // 开发环境下强行加入正在测试的 ID，确保静态导出模式下能打开
    const testIds = ['CXEAWw4ToyR', 'EPLdkTpC39i'];
    testIds.forEach(id => {
      if (!params.find(p => p.id === id)) {
        params.push({ id });
      }
    });

    return params;
  } catch (error) {
    console.error('Failed to generate static params:', error);
    return [{ id: 'CXEAWw4ToyR' }];
  }
}

export const dynamicParams = false;

export default async function BookDetailPage({ params }: BookDetailPageProps) {
  const { id } = await params;
  return (
    <Suspense fallback={<div className="min-h-screen bg-paper" />}>
      <BookDetailContent id={id} />
    </Suspense>
  );
}
