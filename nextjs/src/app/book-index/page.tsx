'use client';

import { Suspense, useMemo, useState, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import LayoutWrapper from '@/components/layout/LayoutWrapper';
import { IndexBrowser, SearchInput, HomePage } from 'book-index-ui';
import type { IndexEntry } from 'book-index-ui';
import { useSource } from '@/components/common/SourceContext';
import { getTransport } from '@/lib/transport';
import BookDetailContent from '@/components/book-index/BookDetailContent';

function BookIndexContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { source } = useSource();

  const transport = useMemo(() => getTransport(source), [source]);

  const detailId = searchParams.get('id');
  const searchQuery = searchParams.get('q');

  const [searchValue, setSearchValue] = useState(searchQuery || '');

  const handleEntryClick = useCallback((entry: IndexEntry) => {
    router.push(`/book-index?id=${entry.id}`);
  }, [router]);

  const handleSearch = useCallback((query: string) => {
    if (query.trim()) {
      router.push(`/book-index?q=${encodeURIComponent(query.trim())}`);
    } else {
      router.push('/book-index');
    }
  }, [router]);

  const handleNavigate = useCallback((id: string) => {
    router.push(`/book-index?id=${id}`);
  }, [router]);

  // 详情视图
  if (detailId) {
    return <BookDetailContent id={detailId} />;
  }

  // 搜索结果视图
  if (searchQuery) {
    return (
      <LayoutWrapper hideFooter>
        <div className="max-w-5xl mx-auto py-8 px-4">
          <div className="mb-6">
            <SearchInput
              transport={transport}
              value={searchValue}
              onChange={setSearchValue}
              onSearch={handleSearch}
              onEntrySelect={handleEntryClick}
            />
          </div>
          <IndexBrowser
            transport={transport}
            hideModeIndicator
            onEntryClick={handleEntryClick}
            initialQuery={searchQuery}
          />
        </div>
      </LayoutWrapper>
    );
  }

  // 首页视图：搜索框 + 推荐/进度 tabs
  return (
    <LayoutWrapper hideFooter>
      <div className="max-w-3xl mx-auto py-16 px-4">
        {/* 突出搜索框 */}
        <div className="mb-12">
          <SearchInput
            transport={transport}
            value={searchValue}
            onChange={setSearchValue}
            onSearch={handleSearch}
            onEntrySelect={handleEntryClick}
          />
        </div>

        {/* 推荐 + 进度 */}
        <HomePage
          transport={transport}
          onNavigate={handleNavigate}
        />
      </div>
    </LayoutWrapper>
  );
}

export default function BookIndexPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-paper" />}>
      <BookIndexContent />
    </Suspense>
  );
}
