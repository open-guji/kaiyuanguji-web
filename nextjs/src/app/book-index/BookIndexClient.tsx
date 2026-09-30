'use client';

import { Suspense, useMemo, useState, useCallback, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import LayoutWrapper from '@/components/layout/LayoutWrapper';
import { BidUrlProvider, IndexBrowser, HomePage, LocaleProvider, LocaleToggle, RepoSourceLink, filtersFromParams, filtersToParams } from 'book-index-ui';
import type { IndexEntry, SearchFilters } from 'book-index-ui';
type TabKey = 'recommend' | 'catalog' | 'collection' | 'site' | 'feedback';
import { useSource } from '@/components/common/SourceContext';
import { getTransport, getSearchBaseUrl } from '@/lib/transport';
import { getSearchClient } from '@/lib/search/client';
import { usePrefetchSearch } from '@/lib/search/use-prefetch-search';
import { isSearchDegraded, subscribeSearchDegraded } from '@/lib/search/meili-storage';
import { REPO_ROOT_DRAFT } from '@/lib/repo-source';
import { COS_BASE } from '@/lib/cos-storage';
import BookDetailContent from '@/components/book-index/BookDetailContent';
import { entryHref } from '@/components/book-index/SearchResultCard';
import styles from './page.module.css';

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
    <div style={{ textAlign: 'center', padding: '16px 0 8px', fontSize: '12px', color: 'var(--bim-aux-fg, #6f6457)' }}>
      {info}
    </div>
  );
}

/** L1（搜索代理）故障、当前结果来自浏览器兜底（L2 轻量分片）时的提示 */
function SearchDegradedNotice() {
  const [degraded, setDegraded] = useState(isSearchDegraded);
  useEffect(() => subscribeSearchDegraded(setDegraded), []);
  if (!degraded) return null;
  return (
    <div
      role="status"
      style={{
        margin: '0 0 12px', padding: '8px 12px', fontSize: '13px', lineHeight: 1.6,
        color: '#8a5a00', background: '#fff8e6', border: '1px solid #f0d9a8', borderRadius: 6,
      }}
    >
      搜索服务暂时不可用，当前为简易搜索（仅按书名、作者匹配），结果可能不全。
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
  // 搜索筛选（朝代／部类／资源／存佚）在 URL 里：dy／cls／img／txt／col／loss，可分享、可后退
  const filters = useMemo(() => filtersFromParams(searchParams), [searchParams]);
  const tabParam = searchParams.get('tab') as TabKey | null;

  // 预热搜索 worker — 详细策略见 use-prefetch-search.ts。
  // 配了 L1 (Meili) 时，搜索默认走 L1，不预热 worker shard（省 2 MB gzip 流量）。
  // L1 失败的 fallback 路径会按需 init worker。
  const hasMeiliL1 = !!process.env.NEXT_PUBLIC_MEILI_URL;
  usePrefetchSearch({
    detailId,
    searchQuery,
    // cos 模式下，搜索分片在 https://data.kaiyuanguji.com/v/{cacheKey 或 commitId}/search/
    // getSearchBaseUrl 返回 Promise<string>，client.init 会自动 await
    init: () => getSearchClient().init(getSearchBaseUrl(source)),
    enabled: !hasMeiliL1,
  });

  // 搜索结果、首页各 tab 里的条目直接去 /item/<id>，不再绕 /book-index?id=（overview#267 P2-7）
  const handleEntryClick = useCallback((entry: IndexEntry) => {
    router.push(entryHref(entry.id));
  }, [router]);

  const handleNavigate = useCallback((id: string) => {
    router.push(entryHref(id));
  }, [router]);

  // 换检索词时保留已选筛选（筛选是「怎么看这批结果」，不随词清掉）；清空检索词回首页态，筛选一并去掉
  const handleQueryChange = useCallback((query: string) => {
    if (query.trim()) {
      const params = filtersToParams(filters);
      params.set('q', query.trim());
      router.push(`/book-index?${params}`);
    } else {
      router.push('/book-index');
    }
  }, [router, filters]);

  const handleFiltersChange = useCallback((next: SearchFilters) => {
    const params = filtersToParams(next, new URLSearchParams(searchParams.toString()));
    router.push(`/book-index?${params}`, { scroll: false });
  }, [router, searchParams]);

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
      {/* 条目链接一律是 /item/<id>（真 <a href>：新标签页、复制链接都对）；组件库默认是 /book-index?id= */}
      <BidUrlProvider buildUrl={entryHref}>
      {/*
        * 有搜索词时放宽容器，让卡片网格能排到 3 列；无搜索词的首页态维持 800px，
        * 否则搜索框和空状态会被拉得过宽。手机上左右留外壳的 16px 边距。
        */}
      <div className={searchQuery ? `${styles.page} ${styles.withQuery}` : styles.page}>
        {searchQuery && <SearchDegradedNotice />}
        <IndexBrowser
          transport={transport}
          onEntryClick={handleEntryClick}
          filtersEnabled
          filters={filters}
          onFiltersChange={handleFiltersChange}
          hideModeIndicator
          // 有检索词才预留一屏高度（结果加载时页面不跳）；没有检索词时下面的首页页签不能被推出首屏（book-index-ui 0.11.1）
          reserveViewportHeight={!!searchQuery}
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
      </BidUrlProvider>
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
