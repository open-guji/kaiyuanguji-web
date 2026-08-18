import Link from 'next/link';
import type { ToolPageInfo } from '@/lib/constants';

/**
 * 小工具占位页。
 *
 * 这些工具尚未接入任何数据源，页面**只声明用途与状态**，
 * 不展示任何检索框、示例词条或进度百分比——避免让人误以为功能已可用。
 */
export default function ToolPlaceholder({ tool }: { tool: ToolPageInfo }) {
  return (
    <div className="mx-auto flex w-full max-w-[860px] flex-col items-center px-6 pb-16 pt-12 text-center">
      <span
        className="mb-6 rounded-full border px-3.5 py-1 text-xs font-bold tracking-[2px]
                   border-[color-mix(in_srgb,var(--color-accent-gold)_45%,transparent)]
                   bg-[color-mix(in_srgb,var(--color-accent-gold)_10%,transparent)]
                   text-accent-gold"
      >
        小工具 · {tool.group}
      </span>

      <div className="mb-5 text-[3.4rem] leading-none" aria-hidden="true">
        {tool.icon}
      </div>

      <h1 className="mb-2 text-4xl font-bold tracking-[4px] text-ink">{tool.title}</h1>

      <nav className="mb-8 text-sm text-secondary" aria-label="面包屑">
        <Link href="/tools" className="no-underline hover:underline">
          小工具
        </Link>
        <span className="mx-1.5">/</span>
        <span>{tool.group}</span>
        <span className="mx-1.5">/</span>
        <span>{tool.title}</span>
      </nav>

      <div
        className="w-full rounded-[14px] border border-dashed p-10 shadow-[var(--shadow-soft)]
                   border-[color-mix(in_srgb,var(--color-accent-gold)_55%,var(--color-border))]
                   bg-surface"
      >
        <h2 className="mb-3 text-xl font-bold text-ink">页面建设中</h2>
        <p className="mx-auto max-w-prose leading-loose text-secondary">{tool.intent}</p>
        <p className="mt-2 leading-loose text-secondary">
          目前尚未接入数据源，功能未开放。
        </p>

        <p className="mt-6 inline-flex items-center gap-2 rounded-full border border-border bg-paper px-3.5 py-1 text-sm text-secondary">
          <span
            className="inline-block h-2 w-2 rounded-full bg-accent-gold"
            aria-hidden="true"
          />
          状态：规划中
        </p>
      </div>

      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <Link
          href="/tools"
          className="rounded-[var(--radius-pill)] border border-border bg-surface px-4 py-2 text-sm no-underline transition-colors hover:border-vermilion/40 hover:text-vermilion"
        >
          返回小工具
        </Link>
        <Link
          href="/book-index"
          className="rounded-[var(--radius-pill)] border border-border bg-surface px-4 py-2 text-sm no-underline transition-colors hover:border-vermilion/40 hover:text-vermilion"
        >
          前往古籍索引
        </Link>
      </div>
    </div>
  );
}
