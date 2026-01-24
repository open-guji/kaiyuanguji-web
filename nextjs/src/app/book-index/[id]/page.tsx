import LayoutWrapper from '@/components/layout/LayoutWrapper';
import MarkdownRenderer from '@/components/markdown/MarkdownRenderer';
import { findBookById, fetchBookContent, getTypeLabel, getStatusLabel } from '@/services/bookIndex';
import { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';

interface BookDetailPageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({
  params,
}: BookDetailPageProps): Promise<Metadata> {
  const { id } = await params;

  try {
    const book = await findBookById(id);
    return {
      title: book ? `${book.name} - 古籍详情` : `古籍详情 - ${id}`,
      description: book ? `查看古籍《${book.name}》的详细信息。` : `查看古籍 ${id} 的详细信息。`,
    };
  } catch {
    return {
      title: `古籍详情 - ${id}`,
      description: `查看古籍 ${id} 的详细信息。`,
    };
  }
}

export default async function BookDetailPage({ params }: BookDetailPageProps) {
  const { id } = await params;

  try {
    // 查找古籍
    const book = await findBookById(id);
    if (!book) {
      notFound();
    }

    // 获取内容
    const content = await fetchBookContent(book);

    return (
      <LayoutWrapper>
        <div className="max-w-4xl mx-auto px-6 py-8">
          {/* 面包屑导航 */}
          <div className="flex items-center gap-3 mb-6 flex-wrap">
            <Link
              href="/book-index"
              className="flex items-center gap-1 text-sm text-secondary hover:text-vermilion transition-colors"
            >
              <svg
                className="w-4 h-4"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path d="M15 19l-7-7 7-7" />
              </svg>
              <span>返回索引</span>
            </Link>

            <span className="text-secondary">|</span>

            {/* 类型标签 */}
            <span className="px-2 py-1 text-xs font-medium rounded bg-paper text-secondary border border-border">
              {getTypeLabel(book.type)}
            </span>

            {/* 状态标签 */}
            <span
              className={`
                px-2 py-1 text-xs font-medium rounded
                ${
                  book.isDraft
                    ? 'text-orange-600 bg-orange-50'
                    : 'text-green-600 bg-green-50'
                }
              `}
            >
              {getStatusLabel(book.isDraft)}
            </span>
          </div>

          {/* ID 信息 */}
          <div className="mb-6 p-3 bg-paper rounded-lg border border-border">
            <code className="text-sm text-secondary font-mono">
              ID: {book.id}
            </code>
          </div>

          {/* 书籍标题 */}
          <h1 className="text-4xl font-bold text-ink mb-8 tracking-wide">
            {book.name}
          </h1>

          {/* 元数据 */}
          {(book.author || book.year || book.holder || book.collection) && (
            <div className="mb-8 p-4 bg-paper rounded-lg space-y-2 text-sm">
              {book.author && (
                <div>
                  <span className="text-secondary">作者：</span>
                  <span className="text-ink">{book.author}</span>
                </div>
              )}
              {book.year && (
                <div>
                  <span className="text-secondary">年份：</span>
                  <span className="text-ink">{book.year}</span>
                </div>
              )}
              {book.collection && (
                <div>
                  <span className="text-secondary">收录于：</span>
                  <span className="text-ink">{book.collection}</span>
                </div>
              )}
              {book.holder && (
                <div>
                  <span className="text-secondary">现藏于：</span>
                  <span className="text-ink">{book.holder}</span>
                </div>
              )}
            </div>
          )}

          {/* Markdown 内容 */}
          <div className="prose max-w-none">
            <MarkdownRenderer content={content} />
          </div>
        </div>
      </LayoutWrapper>
    );
  } catch (error) {
    notFound();
  }
}
