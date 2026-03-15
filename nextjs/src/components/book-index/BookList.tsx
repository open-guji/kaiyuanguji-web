'use client';

import { useState, useEffect, useMemo } from 'react';
import { BookIndexItem, BookResourceType } from '@/types';
import { fetchAllBooks } from '@/services/bookIndex';
import BookListItem from './BookListItem';
import { useSource } from '../common/SourceContext';

const FILTER_TYPES = [
  { id: 'all', label: '全部' },
  { id: BookResourceType.WORK, label: '作品' },
  { id: BookResourceType.COLLECTION, label: '丛编' },
  { id: BookResourceType.BOOK, label: '书' },
];

const ITEMS_PER_PAGE = 9; // 3行 x 3列

// 分页组件
function Pagination({
  currentPage,
  totalPages,
  onPageChange,
}: {
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}) {
  if (totalPages <= 1) return null;

  const getPageNumbers = () => {
    const pages: (number | string)[] = [];
    const maxVisible = 5;

    if (totalPages <= maxVisible) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
      if (currentPage <= 3) {
        for (let i = 1; i <= 4; i++) pages.push(i);
        pages.push('...');
        pages.push(totalPages);
      } else if (currentPage >= totalPages - 2) {
        pages.push(1);
        pages.push('...');
        for (let i = totalPages - 3; i <= totalPages; i++) pages.push(i);
      } else {
        pages.push(1);
        pages.push('...');
        for (let i = currentPage - 1; i <= currentPage + 1; i++) pages.push(i);
        pages.push('...');
        pages.push(totalPages);
      }
    }
    return pages;
  };

  return (
    <div className="flex items-center justify-center gap-2 mt-6">
      <button
        onClick={() => onPageChange(currentPage - 1)}
        disabled={currentPage === 1}
        className="px-3 py-1.5 text-sm rounded border border-border/60
                   disabled:opacity-40 disabled:cursor-not-allowed
                   hover:border-vermilion/40 hover:text-vermilion transition-all"
      >
        上一页
      </button>

      <div className="flex items-center gap-1">
        {getPageNumbers().map((page, idx) =>
          typeof page === 'number' ? (
            <button
              key={idx}
              onClick={() => onPageChange(page)}
              className={`w-8 h-8 text-sm rounded transition-all
                ${currentPage === page
                  ? 'bg-ink text-white'
                  : 'hover:bg-paper/60 text-secondary'
                }`}
            >
              {page}
            </button>
          ) : (
            <span key={idx} className="px-1 text-secondary">
              {page}
            </span>
          )
        )}
      </div>

      <button
        onClick={() => onPageChange(currentPage + 1)}
        disabled={currentPage === totalPages}
        className="px-3 py-1.5 text-sm rounded border border-border/60
                   disabled:opacity-40 disabled:cursor-not-allowed
                   hover:border-vermilion/40 hover:text-vermilion transition-all"
      >
        下一页
      </button>
    </div>
  );
}

// 分类区块组件
function CategorySection({
  title,
  books,
  showPagination = false,
}: {
  title: string;
  books: BookIndexItem[];
  showPagination?: boolean;
}) {
  const [currentPage, setCurrentPage] = useState(1);

  const totalPages = showPagination ? Math.ceil(books.length / ITEMS_PER_PAGE) : 1;
  const displayBooks = showPagination
    ? books.slice((currentPage - 1) * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE)
    : books;

  if (books.length === 0) return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 px-2">
        <h2 className="text-lg font-semibold text-ink">{title}</h2>
        <span className="text-sm text-secondary">({books.length})</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {displayBooks.map((book) => (
          <BookListItem key={book.id} book={book} />
        ))}
      </div>

      {showPagination && (
        <Pagination
          currentPage={currentPage}
          totalPages={totalPages}
          onPageChange={setCurrentPage}
        />
      )}
    </div>
  );
}

export default function BookList() {
  const { source } = useSource();
  const [allBooks, setAllBooks] = useState<BookIndexItem[]>([]);
  const [selectedType, setSelectedType] = useState('all');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 加载数据
  useEffect(() => {
    const loadBooks = async () => {
      try {
        setIsLoading(true);
        setError(null);
        const books = await fetchAllBooks(source);
        setAllBooks(books);
      } catch (err) {
        setError(err instanceof Error ? err.message : '加载失败');
      } finally {
        setIsLoading(false);
      }
    };

    loadBooks();
  }, [source]);

  // 按类型分组
  const { works, books, collections } = useMemo(() => {
    return {
      works: allBooks.filter((b) => b.type === BookResourceType.WORK),
      books: allBooks.filter((b) => b.type === BookResourceType.BOOK),
      collections: allBooks.filter((b) => b.type === BookResourceType.COLLECTION),
    };
  }, [allBooks]);

  // 过滤后的书籍
  const filteredBooks = useMemo(() => {
    if (selectedType === 'all') return allBooks;
    return allBooks.filter((book) => book.type === selectedType);
  }, [selectedType, allBooks]);

  // 重载/重试
  const handleRetry = () => {
    setIsLoading(true);
    setError(null);
    fetchAllBooks(source)
      .then((books) => {
        setAllBooks(books);
      })
      .catch((err) => setError(err instanceof Error ? err.message : '加载失败'))
      .finally(() => setIsLoading(false));
  };

  return (
    <div className="px-6 py-8 md:px-12 lg:px-16 space-y-8">
      {/* Search and Filters */}
      <div className="bg-white p-6 rounded-2xl border border-border/40 shadow-sm space-y-4">
        <div className="relative">
          <input
            type="text"
            placeholder="搜索功能正在开发中。。。"
            disabled
            className="w-full pl-10 pr-4 py-3 bg-paper/30 border border-border/40 rounded-xl
                     text-secondary/60 cursor-not-allowed"
          />
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-secondary/30"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-secondary mr-2">类型筛选:</span>
            {FILTER_TYPES.map((type) => (
              <button
                key={type.id}
                onClick={() => setSelectedType(type.id)}
                className={`
                  px-4 py-1.5 text-xs rounded-full border transition-all
                  ${selectedType === type.id
                    ? 'bg-ink text-white border-ink'
                    : 'bg-transparent text-secondary border-border/60 hover:border-vermilion/40 hover:text-vermilion'
                  }
                `}
              >
                {type.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <p className="text-secondary text-sm">
              找到 <span className="text-ink font-semibold">{filteredBooks.length}</span> 部相关古籍
              {source === 'github' ? ' (GitHub 源)' : ' (Gitee 源)'}
            </p>
            {error && (
              <button
                onClick={handleRetry}
                className="text-vermilion text-xs hover:underline"
              >
                重试
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Loading State */}
      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="bg-paper/30 h-48 rounded-2xl animate-pulse" />
          ))}
        </div>
      ) : selectedType === 'all' ? (
        // 不筛选时：分三部分显示
        <div className="space-y-8">
          <CategorySection title="作品" books={works} />
          <CategorySection title="书" books={books} showPagination />
          <CategorySection title="丛编" books={collections} />
        </div>
      ) : filteredBooks.length > 0 ? (
        // 筛选时：显示筛选结果
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {filteredBooks.map((book) => (
            <BookListItem key={book.id} book={book} />
          ))}
        </div>
      ) : (
        <div className="py-20 text-center bg-paper/20 rounded-3xl border border-dashed border-border/40">
          <p className="text-secondary">未找到匹配的古籍</p>
          <button
            onClick={() => setSelectedType('all')}
            className="mt-4 text-vermilion text-sm hover:underline"
          >
            清除所有过滤条件
          </button>
        </div>
      )}
    </div>
  );
}
