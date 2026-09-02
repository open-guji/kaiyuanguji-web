'use client';

import { Suspense, useMemo, useState, useCallback, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import LayoutWrapper from '@/components/layout/LayoutWrapper';
import { IndexBrowser, HomePage, LocaleProvider, LocaleToggle, RepoSourceLink } from 'book-index-ui';
import type { IndexEntry } from 'book-index-ui';
type TabKey = 'recommend' | 'catalog' | 'collection' | 'site' | 'feedback';
import { useSource } from '@/components/common/SourceContext';
import { getTransport, getSearchBaseUrl } from '@/lib/transport';
import { getSearchClient } from '@/lib/search/client';
import { usePrefetchSearch } from '@/lib/search/use-prefetch-search';
import { REPO_ROOT_DRAFT } from '@/lib/repo-source';
import { COS_BASE } from '@/lib/cos-storage';
import BookDetailContent from '@/components/book-index/BookDetailContent';

function DataVersion() {
  const { source } = useSource();
  const [info, setInfo] = useState('');

  useEffect(() => {
    // 取版本号 JSON 的 URL：cos 模式下直接读 latest.json（本身就是发布指针，
    // 天然带 no-store 且不缓存；current/version.json 不带 ?v= cache-bust，
    // 会被 CDN 的 current/* immutable 长缓存策略缓存住，显示的版本号永远滞后）。
    // 其他模式走同站 /data/version.json。
    const urlP = source === 'cos'
      ? Promise.resolve(`${COS_BASE}/latest.json`)
      : Promise.resolve('/data/version.json');

    urlP
      .then(u => fetch(u))
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
  }, [source]);

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

  // 预热搜索 worker — 详细策略见 use-prefetch-search.ts。
  // 配了 L1 (Meili) 时，搜索默认走 L1，不预热 worker shard（省 2 MB gzip 流量）。
  // L1 失败的 fallback 路径会按需 init worker。
  const hasMeiliL1 = !!process.env.NEXT_PUBLIC_MEILI_URL;
  usePrefetchSearch({
    detailId,
    searchQuery,
    // cos 模式下，搜索分片在 https://data.kaiyuanguji.com/v/{commit}/search/
    // getSearchBaseUrl 返回 Promise<string>，client.init 会自动 await
    init: () => getSearchClient().init(getSearchBaseUrl(source)),
    enabled: !hasMeiliL1,
  });

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
      {/*
        * 有搜索词时放宽容器，让 resultVariant="card" 的自适应网格能排到 3 列
        * （对齐设计稿的「右侧卡片网格」）；无搜索词的首页态维持原来的 800px，
        * 否则搜索框和空状态会被拉得过宽。
        */}
      <div style={{ maxWidth: searchQuery ? '1120px' : '800px', margin: '0 auto', padding: '32px 16px' }}>
        <IndexBrowser
          transport={transport}
          onEntryClick={handleEntryClick}
          resultVariant="card"
          hideModeIndicator
          initialQuery={searchQuery || undefined}
          onQueryChange={handleQueryChange}
          headerRight={
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <LocaleToggle />
              <RepoSourceLink {...REPO_ROOT_DRAFT} />
            </span>
          }
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
