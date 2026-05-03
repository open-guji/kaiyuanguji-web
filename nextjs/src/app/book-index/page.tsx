'use client';

import { Suspense, useMemo, useState, useCallback, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import LayoutWrapper from '@/components/layout/LayoutWrapper';
import { IndexBrowser, HomePage, LocaleProvider, LocaleToggle } from 'book-index-ui';
import type { IndexEntry } from 'book-index-ui';
type TabKey = 'recommend' | 'catalog' | 'collection' | 'site' | 'feedback';
import { useSource } from '@/components/common/SourceContext';
import { getTransport } from '@/lib/transport';
import { getSearchClient } from '@/lib/search/client';
import BookDetailContent from '@/components/book-index/BookDetailContent';

function DataVersion() {
  const [info, setInfo] = useState('');

  useEffect(() => {
    fetch('/data/version.json')
      .then(r => r.ok ? r.json() : null)
      .then(v => {
        if (!v?.commitId || v.commitId === 'unknown') return;
        const short = v.commitId.slice(0, 7);
        const date = v.commitDate
          ? new Date(v.commitDate).toLocaleString('zh-CN', { hour12: false })
          : '';
        setInfo(`数据版本: ${short}${date ? ` (${date})` : ''}`);
      })
      .catch(() => {});
  }, []);

  if (!info) return null;

  return (
    <div style={{ textAlign: 'center', padding: '16px 0 8px', fontSize: '12px', color: '#999' }}>
      {info}
    </div>
  );
}

function BookIndexContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { source } = useSource();

  const transport = useMemo(() => getTransport(source), [source]);

  const detailId = searchParams.get('id');
  const searchQuery = searchParams.get('q');
  const tabParam = searchParams.get('tab') as TabKey | null;

  // 预热搜索 worker：在用户表现出"打算搜索"的迹象时才下 ~2 MB gzip 索引。
  //
  // 触发条件（任一即可）：
  //   - 用户在 /book-index 停留 ≥ 5 秒（说明在浏览，不是匆匆掠过）
  //   - 用户聚焦了任何 input（搜索框唯一的可聚焦输入）
  //   - 用户已经在搜索（URL 带 ?q=）
  //
  // 详情页（detailId）不预热——大部分详情访客不返回搜索。
  useEffect(() => {
    if (detailId) return;
    if (typeof window === 'undefined') return;

    let triggered = false;
    const trigger = () => {
      if (triggered) return;
      triggered = true;
      cleanup();
      getSearchClient().init().catch(() => { /* 静默失败 */ });
    };

    const onFocus = (e: FocusEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') trigger();
    };
    const cleanup = () => {
      window.clearTimeout(timer);
      document.removeEventListener('focusin', onFocus, true);
    };

    // URL 带 q= 说明用户主动搜索（deep link 或刚提交），立即预热
    if (searchQuery) { trigger(); return; }

    document.addEventListener('focusin', onFocus, true);
    const timer = window.setTimeout(trigger, 5000);

    return cleanup;
  }, [detailId, searchQuery]);

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
          feedbackApiUrl="/api/feedback"
        />
        <DataVersion />
      </div>
    </LayoutWrapper>
  );
}

export default function BookIndexPage() {
  return (
    <LocaleProvider>
      <Suspense fallback={<div className="min-h-screen bg-paper flex items-center justify-center text-sm text-stone-400">加载中...</div>}>
        <BookIndexContent />
      </Suspense>
    </LocaleProvider>
  );
}
