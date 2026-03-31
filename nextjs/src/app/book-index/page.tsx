'use client';

import { Suspense, useMemo, useState, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import LayoutWrapper from '@/components/layout/LayoutWrapper';
import { IndexBrowser, HomePage, LocaleProvider, LocaleToggle } from 'book-index-ui';
import type { IndexEntry } from 'book-index-ui';
type TabKey = 'recommend' | 'catalog' | 'site';
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
  const tabParam = searchParams.get('tab') as TabKey | null;

  const handleEntryClick = useCallback((entry: IndexEntry) => {
    router.push(`/book-index?id=${entry.id}`);
  }, [router]);

  const handleNavigate = useCallback((id: string) => {
    router.push(`/book-index?id=${id}`);
  }, [router]);

  const handleQueryChange = useCallback((query: string) => {
    if (query.trim()) {
      router.push(`/book-index?q=${encodeURIComponent(query.trim())}`);
    } else {
      router.push('/book-index');
    }
  }, [router]);

  const handleTabChange = useCallback((tab: TabKey) => {
    router.push(`/book-index?tab=${tab}`, { scroll: false });
  }, [router]);

  // 详情视图
  if (detailId) {
    return <BookDetailContent id={detailId} />;
  }

  // 首页视图（含搜索结果）
  return (
    <LayoutWrapper hideFooter>
      <div style={{ maxWidth: '800px', margin: '0 auto', padding: '32px 16px' }}>
        <IndexBrowser
          transport={transport}
          onEntryClick={handleEntryClick}
          hideModeIndicator
          initialQuery={searchQuery || undefined}
          onQueryChange={handleQueryChange}
          headerRight={<LocaleToggle />}
        />
        <HomePage
          transport={transport}
          onNavigate={handleNavigate}
          activeTab={tabParam || undefined}
          onTabChange={handleTabChange}
        />
      </div>
    </LayoutWrapper>
  );
}

export default function BookIndexPage() {
  return (
    <LocaleProvider>
      <Suspense fallback={<div className="min-h-screen bg-paper" />}>
        <BookIndexContent />
      </Suspense>
    </LocaleProvider>
  );
}
