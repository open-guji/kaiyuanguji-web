'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function HeroSection() {
  const router = useRouter();
  const [query, setQuery] = useState('');

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    router.push(q ? `/book-index?q=${encodeURIComponent(q)}` : '/book-index');
  };

  return (
    <section
      className="hero-banner relative flex items-center justify-center overflow-hidden
                 border-b border-border px-6 py-16"
    >
      {/* 内容 */}
      <div className="relative z-10 flex w-full max-w-[900px] flex-col items-center gap-6 text-center">
        {/* 主标题：印章落款式入场 */}
        <h1 className="anim-seal text-5xl font-semibold tracking-[0.3rem] text-ink md:text-7xl md:tracking-[0.4rem]">
          开源古籍
        </h1>

        {/* 副标题 */}
        <h2 className="anim-fade-up anim-delay-1 text-xl font-bold tracking-[2px] text-vermilion md:text-2xl">
          让科技赋予古籍数字生命
        </h2>

        {/* 说明 */}
        <p className="anim-fade-up anim-delay-2 max-w-2xl text-base leading-loose text-ink md:text-lg">
          全线软件基于 Apache-2.0 协议开源，结合最前沿的 AI 技术与传统版本学、目录学，
          推动古籍数字化、校对、排版与开源存储。
        </p>

        {/* 搜索卡片 */}
        <form
          onSubmit={handleSearch}
          className="anim-fade-up anim-delay-3 mt-2 w-full max-w-[850px] rounded-xl border
                     border-border bg-surface p-5 shadow-[var(--shadow-soft)]"
        >
          <div className="flex flex-wrap gap-2.5">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="在 11 万+ 条古籍索引中搜索书名、作者、分类或来源..."
              aria-label="搜索古籍索引"
              className="min-w-0 flex-1 rounded-lg border border-border bg-paper px-5 py-3.5
                         text-base text-ink outline-none transition-[border-color,box-shadow]
                         placeholder:text-secondary/70
                         focus:border-vermilion
                         focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-vermilion)_18%,transparent)]"
            />
            <button
              type="submit"
              className="rounded-lg bg-vermilion px-8 py-3.5 font-medium text-white
                         transition-colors hover:bg-vermilion-deep"
            >
              搜索
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
