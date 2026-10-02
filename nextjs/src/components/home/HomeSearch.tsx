'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSiteT } from '@/i18n/use-site-t';
import SearchSuggest from '@/components/common/SearchSuggest';

/**
 * 首屏大检索框 + 全页唯一的主按钮「搜索」。
 * action 兜底：JS 未加载时表单照样 GET 到 /book-index?q=。
 * 边输边出候选（overview#342）：调同站 /api/search，不引 book-index-ui，首页不变重。
 */
export default function HomeSearch() {
  const router = useRouter();
  const t = useSiteT();
  const [query, setQuery] = useState('');

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    router.push(q ? `/book-index?q=${encodeURIComponent(q)}` : '/book-index');
  };

  return (
    <form className="home-search" action="/book-index" method="get" role="search" onSubmit={handleSearch}>
      <svg className="home-search-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
        <circle cx="11" cy="11" r="6.5" />
        <path d="M16 16l4.5 4.5" />
      </svg>
      <SearchSuggest
        className="home-search-field"
        value={query}
        onChange={setQuery}
        placeholder={t('home.search.placeholder')}
        aria-label={t('home.search.aria')}
      />
      <button type="submit" className="og-btn">
        {t('home.search.submit')}
      </button>
    </form>
  );
}
