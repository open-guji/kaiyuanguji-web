import Link from 'next/link';
import { BookIndexItem, BookResourceType } from '@/types';
import { getTypeLabel, getStatusLabel } from '@/services/bookIndex';

interface BookListItemProps {
  book: BookIndexItem;
}

export default function BookListItem({ book }: BookListItemProps) {
  // 根据类型设置图标和颜色
  const getTypeIcon = () => {
    switch (book.type) {
      case BookResourceType.WORK:
        return '📖'; // 作品
      case BookResourceType.COLLECTION:
        return '📚'; // 丛编
      case BookResourceType.BOOK:
        return '📕'; // 书
      default:
        return '📄';
    }
  };

  const getTypeColor = () => {
    switch (book.type) {
      case BookResourceType.WORK:
        return 'text-blue-600 bg-blue-50 border-blue-200';
      case BookResourceType.COLLECTION:
        return 'text-purple-600 bg-purple-50 border-purple-200';
      case BookResourceType.BOOK:
        return 'text-vermilion bg-vermilion/5 border-vermilion/20';
      default:
        return 'text-secondary bg-paper border-border';
    }
  };

  return (
    <Link
      href={`/book-index/${book.id}`}
      className="block p-4 bg-white border border-border rounded-lg
                 hover:border-vermilion hover:shadow-md transition-all"
    >
      <div className="flex items-start justify-between gap-4">
        {/* 左侧：图标 + 信息 */}
        <div className="flex items-start gap-3 flex-1 min-w-0">
          {/* 类型图标 */}
          <span className="text-2xl flex-shrink-0 mt-0.5">
            {getTypeIcon()}
          </span>

          {/* 书籍信息 */}
          <div className="flex-1 min-w-0">
            <h3 className="text-lg font-semibold text-ink mb-2 break-words">
              {book.name}
            </h3>

            <div className="flex flex-wrap items-center gap-2 text-sm text-secondary">
              {book.author && (
                <span className="text-xs">作者: {book.author}</span>
              )}

              {book.year && (
                <span className="text-xs">{book.year}</span>
              )}
            </div>
          </div>
        </div>

        {/* 右侧：标签 */}
        <div className="flex flex-col gap-2 items-end flex-shrink-0">
          {/* 类型标签 */}
          <span
            className={`
              px-2 py-1 text-xs font-medium rounded border
              ${getTypeColor()}
            `}
          >
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
      </div>
    </Link>
  );
}
