'use client';

import { Suspense, useMemo, useState, useCallback, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import LayoutWrapper from '@/components/layout/LayoutWrapper';
import { BidUrlProvider, IndexBrowser, filtersFromParams, filtersToParams, resultTabFromParam, resultTabToParam } from 'book-index-ui';
import BimLocaleProvider from '@/components/common/BimLocaleProvider';
import type { IndexEntry, ResultTab, SearchFilters } from 'book-index-ui';
import { useSource } from '@/components/common/SourceContext';
import { getTransport, getSearchBaseUrl } from '@/lib/transport';
import { getSearchClient } from '@/lib/search/client';
import { usePrefetchSearch } from '@/lib/search/use-prefetch-search';
import { isSearchDegraded, subscribeSearchDegraded } from '@/lib/search/meili-storage';
import BookDetailContent from '@/components/book-index/BookDetailContent';
import { entryHref } from '@/lib/item-id';
import MetaHome from './MetaHome';
import { useSiteT } from '@/i18n/use-site-t';
import styles from './page.module.css';

/** L1（搜索代理）故障、当前结果来自浏览器兜底（L2 轻量分片）时的提示 */
function SearchDegradedNotice() {
  const t = useSiteT();
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
      {t('bookIndex.searchDegraded')}
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
  // 结果页签（全部／作品／丛编／版本／人物）也在 URL 里：?tab=work，刷新、分享后保留（overview#359 P2-3）
  const resultTab = resultTabFromParam(searchParams.get('tab'));

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

  // 搜索结果里的条目直接去 /item/<id>，不再绕 /book-index?id=（overview#267 P2-7）
  const handleEntryClick = useCallback((entry: IndexEntry) => {
    router.push(entryHref(entry.id));
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

  // 换了筛选（只换排序不算）组件会回到「全部」：地址里的 tab 一并去掉，与界面一致
  const handleFiltersChange = useCallback((next: SearchFilters) => {
    const params = filtersToParams(next, new URLSearchParams(searchParams.toString()));
    const withoutSort = (f: SearchFilters) => filtersToParams({ ...f, sort: '' }).toString();
    if (withoutSort(next) !== withoutSort(filters)) params.delete('tab');
    router.push(`/book-index?${params}`, { scroll: false });
  }, [router, searchParams, filters]);

  // 切页签只换地址里的 tab，不新增历史记录
  const handleResultTabChange = useCallback((tab: ResultTab) => {
    const params = new URLSearchParams(searchParams.toString());
    const v = resultTabToParam(tab);
    if (v) params.set('tab', v); else params.delete('tab');
    router.replace(`/book-index?${params}`, { scroll: false });
  }, [router, searchParams]);

  // 详情视图
  if (detailId) {
    return <BookDetailContent id={detailId} />;
  }

  // 没有检索词：元数据首页（overview#322 块 D）。取代原来的页签（推荐／目录／丛编／在线资源／反馈）与底部数据版本行
  // 元数据是分支页，有页脚（用户 9-30 反馈）
  if (!searchQuery) {
    return (
      <LayoutWrapper>
        <BidUrlProvider buildUrl={entryHref}>
          <div className={`${styles.page} ${styles.home}`}>
            <MetaHome source={source} transport={transport} />
          </div>
        </BidUrlProvider>
      </LayoutWrapper>
    );
  }

  // 检索结果
  return (
    <LayoutWrapper>
      {/* 条目链接一律是 /item/<id>（真 <a href>：新标签页、复制链接都对）；组件库默认是 /book-index?id= */}
      <BidUrlProvider buildUrl={entryHref}>
      <div className={`${styles.page} ${styles.withQuery}`}>
        <SearchDegradedNotice />
        <IndexBrowser
          transport={transport}
          onEntryClick={handleEntryClick}
          filtersEnabled
          filters={filters}
          onFiltersChange={handleFiltersChange}
          resultTab={resultTab}
          onResultTabChange={handleResultTabChange}
          hideModeIndicator
          // 结果加载时预留一屏高度，页面不跳
          reserveViewportHeight
          initialQuery={searchQuery}
          onQueryChange={handleQueryChange}
        />
      </div>
      </BidUrlProvider>
    </LayoutWrapper>
  );
}

function LoadingFallback() {
  const t = useSiteT();
  return <div className="min-h-screen bg-paper flex items-center justify-center text-sm text-stone-400">{t('bookIndex.loading')}</div>;
}

export default function BookIndexPage() {
  return (
    <BimLocaleProvider>
      <Suspense fallback={<LoadingFallback />}>
        <BookIndexContent />
      </Suspense>
    </BimLocaleProvider>
  );
}
