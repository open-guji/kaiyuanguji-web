'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * 首屏大检索框 + 全页唯一的主按钮「搜索」。
 * action 兜底：JS 未加载时表单照样 GET 到 /book-index?q=。
 */
export default function HomeSearch() {
  const router = useRouter();
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
      <input
        type="search"
        name="q"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="书名、作者、版本，如：史记、苏轼"
        aria-label="搜索古籍索引"
      />
      <button type="submit" className="og-btn">
        搜索
      </button>
    </form>
  );
}
