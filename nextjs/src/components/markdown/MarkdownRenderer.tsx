'use client';

import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Components } from 'react-markdown';
import BidLink from '@/components/book-index/BidLink';

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

export default function MarkdownRenderer({ content, className = '' }: MarkdownRendererProps) {
  // 自定义组件样式
  const components: Components = {
    h1: ({ children, ...props }) => (
      <h1 className="text-3xl font-bold text-ink mt-8 mb-4 tracking-wide" {...props}>
        {children}
      </h1>
    ),
    h2: ({ children, ...props }) => (
      <h2 className="mt-8 mb-3 border-l-[3px] border-vermilion pl-3 text-2xl font-bold tracking-wide text-vermilion" {...props}>
        {children}
      </h2>
    ),
    h3: ({ children, ...props }) => (
      <h3 className="text-xl font-semibold text-ink mt-5 mb-2" {...props}>
        {children}
      </h3>
    ),
    h4: ({ children, ...props }) => (
      <h4 className="text-lg font-semibold text-ink mt-4 mb-2" {...props}>
        {children}
      </h4>
    ),
    p: ({ children, ...props }) => (
      <p className="text-base text-ink leading-loose my-4" {...props}>
        {children}
      </p>
    ),
    a: ({ href, children, ...props }) => {
      // 处理古籍引用链接: 支持 bid:ID, bid:\ID, bid:\\ID, bid://ID 等格式
      if (href) {
        try {
          // 解码 href，防止 markdown 将特殊字符编码
          const decodedHref = decodeURIComponent(href);

          // 匹配 bid: 后跟任意数量的斜杠或反斜杠，忽略大小写和空白
          const match = decodedHref.match(/^bid:\s*[\\/]*\s*(.+)$/i);

          if (match) {
            const id = match[1];
            return (
              <BidLink id={id} {...props}>
                {children}
              </BidLink>
            );
          }
        } catch (e) {
          console.warn('Failed to parse bid link:', href, e);
        }
      }

      return (
        <a
          href={href}
          className="text-vermilion hover:underline"
          target={href?.startsWith('http') ? '_blank' : undefined}
          rel={href?.startsWith('http') ? 'noopener noreferrer' : undefined}
          {...props}
        >
          {children}
        </a>
      );
    },
    ul: ({ children, ...props }) => (
      <ul className="list-disc list-inside my-4 space-y-2 text-ink" {...props}>
        {children}
      </ul>
    ),
    ol: ({ children, ...props }) => (
      <ol className="list-decimal list-inside my-4 space-y-2 text-ink" {...props}>
        {children}
      </ol>
    ),
    li: ({ children, ...props }) => (
      <li className="leading-relaxed" {...props}>
        {children}
      </li>
    ),
    blockquote: ({ children, ...props }) => (
      <blockquote
        className="my-4 rounded-r-[var(--radius-pill)] border-l-4 border-vermilion bg-[color-mix(in_srgb,var(--color-vermilion)_5%,var(--color-surface))] py-2 pl-4 pr-3 italic text-secondary"
        {...props}
      >
        {children}
      </blockquote>
    ),
    code: ({ inline, children, ...props }: any) =>
      inline ? (
        <code
          className="bg-border/30 text-vermilion px-1.5 py-0.5 rounded text-sm font-mono"
          {...props}
        >
          {children}
        </code>
      ) : (
        <code
          className="block bg-ink text-white p-4 rounded-lg my-4 overflow-x-auto font-mono text-sm"
          {...props}
        >
          {children}
        </code>
      ),
    pre: ({ children }) => <div className="my-4">{children}</div>,
    table: ({ children, ...props }) => (
      <div className="my-5 overflow-x-auto rounded-[var(--radius-card)] border border-border bg-surface shadow-[var(--shadow-soft)]">
        <table className="min-w-full border-collapse" {...props}>
          {children}
        </table>
      </div>
    ),
    th: ({ children, ...props }) => (
      <th className="border-b-2 border-border bg-[color-mix(in_srgb,var(--color-accent-gold)_8%,var(--color-surface))] px-4 py-2.5 text-left font-semibold" {...props}>
        {children}
      </th>
    ),
    td: ({ children, ...props }) => (
      <td className="border-b border-border px-4 py-2" {...props}>
        {children}
      </td>
    ),
    hr: () => <hr className="my-8 border-border" />,
    strong: ({ children, ...props }) => (
      <strong className="font-bold text-vermilion" {...props}>
        {children}
      </strong>
    ),
    em: ({ children, ...props }) => (
      <em className="italic text-secondary" {...props}>
        {children}
      </em>
    ),
  };

  return (
    <div className={`markdown-content ${className}`}>
      <ReactMarkdown
        components={components}
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) => url}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
