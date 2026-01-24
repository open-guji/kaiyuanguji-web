'use client';

import { useState, useEffect } from 'react';
import { BookIndexItem } from '@/types';
import { fetchAllBooks, searchBooks } from '@/services/bookIndex';
import BookListItem from './BookListItem';

export default function BookList() {
  const [allBooks, setAllBooks] = useState<BookIndexItem[]>([]);
  const [filteredBooks, setFilteredBooks] = useState<BookIndexItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 加载数据
  useEffect(() => {
    const loadBooks = async () => {
      try {
        setIsLoading(true);
        setError(null);
        const books = await fetchAllBooks();
        setAllBooks(books);
        setFilteredBooks(books);
      } catch (err) {
        setError(err instanceof Error ? err.message : '加载失败');
      } finally {
        setIsLoading(false);
      }
    };

    loadBooks();
  }, []);

  // 搜索处理
  useEffect(() => {
    const performSearch = async () => {
      if (!searchQuery.trim()) {
        setFilteredBooks(allBooks);
        return;
      }

      const results = await searchBooks(searchQuery);
      setFilteredBooks(results);
    };

    performSearch();
  }, [searchQuery, allBooks]);

  // 重试加载
  const handleRetry = () => {
    setIsLoading(true);
    setError(null);
    fetchAllBooks()
      .then((books) => {
        setAllBooks(books);
        setFilteredBooks(books);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : '加载失败');
      })
      .finally(() => {
        setIsLoading(false);
      });
  };

  // 加载状态
  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-vermilion mb-4" />
        <p className="text-secondary">正在加载古籍列表...</p>
      </div>
    );
  }

  // 错误状态
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <div className="text-4xl mb-4">⚠️</div>
        <p className="text-secondary mb-4">加载失败: {error}</p>
        <button
          onClick={handleRetry}
          className="px-6 py-2 bg-vermilion text-white rounded-lg hover:bg-vermilion/90"
        >
          重试
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      {/* 标题 */}
      <div className="text-center mb-8">
        <h1 className="text-4xl font-bold text-ink mb-3 tracking-wide">
          古籍索引
        </h1>
        <p className="text-secondary text-lg">
          标准化的古籍数字资源索引系统
        </p>
      </div>

      {/* 搜索框 */}
      <div className="mb-8">
        <div className="relative">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索古籍名称或 ID..."
            className="w-full px-4 py-3 pr-10 border border-border rounded-lg
                     focus:outline-none focus:border-vermilion focus:ring-2 focus:ring-vermilion/20
                     bg-white text-ink"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-secondary hover:text-ink"
              aria-label="清除搜索"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* 结果统计 */}
      <div className="flex items-center justify-between mb-4 text-sm text-secondary">
        <span>
          {searchQuery ? '搜索结果' : '最近收录'}: {filteredBooks.length} 条记录
        </span>
      </div>

      {/* 列表 */}
      {filteredBooks.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20">
          <div className="text-4xl mb-4">🔍</div>
          <p className="text-secondary">
            {searchQuery ? '未找到匹配的古籍' : '暂无收录古籍'}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {filteredBooks.map((book) => (
            <BookListItem key={book.id} book={book} />
          ))}
        </div>
      )}
    </div>
  );
}
