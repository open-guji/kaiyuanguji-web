'use client';

import { useEffect, useRef } from 'react';
import MarkdownRenderer from './MarkdownRenderer';
import TableOfContents from './TableOfContents';
import { TOCItem } from '@/lib/markdown';

interface MarkdownPageProps {
  content: string;
  toc: TOCItem[];
  title?: string;
}

export default function MarkdownPage({ content, toc, title }: MarkdownPageProps) {
  const contentRef = useRef<HTMLDivElement>(null);

  // 为标题添加 ID（用于锚点跳转）
  useEffect(() => {
    if (!contentRef.current) return;

    const headings = contentRef.current.querySelectorAll('h1, h2, h3, h4, h5, h6');
    headings.forEach((heading) => {
      const text = heading.textContent || '';
      const id = text
        .toLowerCase()
        .replace(/[^\u4e00-\u9fa5a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');

      if (id) {
        heading.id = id;
      }
    });
  }, [content]);

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      <div className="flex gap-8">
        {/* 主内容区 */}
        <article
          ref={contentRef}
          className="flex-1 min-w-0 max-w-3xl mx-auto lg:mx-0"
        >
          {title && (
            <h1 className="text-4xl font-bold text-ink mb-8 tracking-wide">
              {title}
            </h1>
          )}
          <MarkdownRenderer content={content} />
        </article>

        {/* 目录侧边栏（仅在桌面显示） */}
        {toc.length > 0 && (
          <aside className="hidden lg:block w-64 flex-shrink-0">
            <TableOfContents items={toc} />
          </aside>
        )}
      </div>
    </div>
  );
}
