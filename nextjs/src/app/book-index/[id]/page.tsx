import LayoutWrapper from '@/components/layout/LayoutWrapper';
import MarkdownRenderer from '@/components/markdown/MarkdownRenderer';
import { findBookById, fetchBookContent, getTypeLabel, getStatusLabel, fetchAllBooks } from '@/services/bookIndex';
import { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import CopyButton from '@/components/common/CopyButton';

interface BookDetailPageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({
  params,
}: BookDetailPageProps): Promise<Metadata> {
  const { id } = await params;

  try {
    const book = await findBookById(id);
    const title = book ? `${book.name} - 古籍详情` : `古籍详情 - ${id}`;
    const description = book ? `查看古籍《${book.name}》的详细信息。` : `查看古籍 ${id} 的详细信息。`;

    return {
      title,
      description,
      alternates: {
        canonical: `/book-index/${id}`,
      },
      openGraph: {
        title,
        description,
        type: 'book',
        url: `/book-index/${id}`,
      },
    };
  } catch {
    return {
      title: `古籍详情 - ${id}`,
      description: `查看古籍 ${id} 的详细信息。`,
      alternates: {
        canonical: `/book-index/${id}`,
      },
    };
  }
}

export async function generateStaticParams() {
  try {
    const books = await fetchAllBooks();
    return books.map((book) => ({
      id: book.id,
    }));
  } catch (error) {
    console.error('Failed to generate static params for books:', error);
    return [];
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
    let content = await fetchBookContent(book);

    // 去重逻辑：移除重复的标题、ID和基本信息部分
    const stripRedundantHeader = (text: string) => {
      // 1. 移除第一行 H1 标题
      let cleanText = text.replace(/^#\s+.+\r?\n*/m, '');

      // 2. 移除可能存在的 ID: xxx 行
      cleanText = cleanText.replace(/^(ID|id)[:：].*\r?\n*/mi, '');

      // 3. 移除“基本信息”区块：匹配 ## 基本信息 直到下一个 ## 标题
      cleanText = cleanText.replace(/^##\s*基本信息\s*\r?\n([\s\S]*?)(?=\r?\n##\s|$)/m, '');

      return cleanText.trim();
    };

    const cleanedContent = stripRedundantHeader(content);

    return (
      <LayoutWrapper>
        <div className="max-w-4xl mx-auto px-6 py-8">
          {/* 顶栏控制区：面包屑 + 标签 + ID */}
          <div className="flex items-center justify-between mb-8 flex-wrap gap-4">
            <div className="flex items-center gap-3 flex-wrap">
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

              <span className="text-secondary/30">|</span>

              {/* 类型标签 */}
              <span className="px-2 py-0.5 text-xs font-medium rounded bg-paper text-secondary border border-border/60">
                {getTypeLabel(book.type)}
              </span>

              {/* 状态标签 */}
              <span
                className={`
                  px-2 py-0.5 text-xs font-medium rounded
                  ${book.isDraft
                    ? 'text-orange-600 bg-orange-50'
                    : 'text-green-600 bg-green-50'
                  }
                `}
              >
                {getStatusLabel(book.isDraft)}
              </span>
            </div>

            {/* ID 复制按钮（置于右上） */}
            <CopyButton text={book.id} label="ID" />
          </div>

          {/* 书籍标题 */}
          <h1 className="text-4xl font-bold text-ink mb-8 tracking-wide">
            {book.name}
          </h1>

          {/* 元数据 */}
          {(book.author || book.year || book.holder || book.collection) && (
            <div className="mb-10 p-5 bg-paper/50 rounded-xl border border-border/40 space-y-3 text-[15px]">
              {book.author && (
                <div className="flex gap-2">
                  <span className="text-secondary flex-shrink-0">作者：</span>
                  <span className="text-ink font-semibold">{book.author}</span>
                </div>
              )}
              {book.year && (
                <div className="flex gap-2">
                  <span className="text-secondary flex-shrink-0">年份：</span>
                  <span className="text-ink font-semibold">{book.year}</span>
                </div>
              )}
              {book.collection && (
                <div className="flex gap-2">
                  <span className="text-secondary flex-shrink-0">收录于：</span>
                  <span className="text-ink font-semibold">{book.collection}</span>
                </div>
              )}
              {book.holder && (
                <div className="flex gap-2">
                  <span className="text-secondary flex-shrink-0">现藏于：</span>
                  <span className="text-ink font-semibold">{book.holder}</span>
                </div>
              )}
            </div>
          )}

          {/* Markdown 内容 */}
          <div className="prose max-w-none">
            <MarkdownRenderer content={cleanedContent} />
          </div>
        </div>
      </LayoutWrapper>
    );
  } catch (error) {
    notFound();
  }
}
