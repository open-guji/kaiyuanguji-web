import { Suspense } from 'react';
import { findBookById, fetchAllBooks } from '@/services/bookIndex';
import { Metadata } from 'next';
import BookDetailContent from '@/components/book-index/BookDetailContent';

interface BookDetailPageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({
  params,
}: BookDetailPageProps): Promise<Metadata> {
  const { id } = await params;

  try {
    // 静态导出默认用 github 数据生成元数据
    const book = await findBookById(id, 'github');
    const title = book ? `${book.name} - 古籍详情` : `古籍详情 - ${id}`;
    const description = book ? `查看古籍《${book.name}》的详细信息。` : `查看古籍 ${id} 的详细信息。`;

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
    const books = await fetchAllBooks('github');
    const params = books.map((book) => ({
      id: book.id,
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
