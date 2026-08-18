import type { Metadata } from 'next';
import Link from 'next/link';
import LayoutWrapper from '@/components/layout/LayoutWrapper';
import { TOOL_PAGES } from '@/lib/constants';

export const metadata: Metadata = {
    title: '小工具',
    description: '古籍阅读与校对辅助工具：词典与韵书。当前均为规划中的占位页，功能尚未开放。',
    alternates: { canonical: '/tools' },
};

const GROUPS = ['词典', '韵书'] as const;

export default function ToolsIndexPage() {
    return (
        <LayoutWrapper>
            <div className="mx-auto w-full max-w-5xl px-6 pb-16 pt-12">
                <header className="mb-10">
                    <h1 className="text-4xl font-bold tracking-[3px] text-ink">小工具</h1>
                    <div className="mt-4 h-0.5 w-16 bg-vermilion" />
                    <p className="mt-5 leading-loose text-secondary">
                        面向古籍阅读与校对的辅助工具。以下各项均在规划中，尚未接入数据源，
                        点进去只会看到用途说明，不会有可用的检索功能。
                    </p>
                </header>

                {GROUPS.map((group) => (
                    <section key={group} className="mb-10">
                        <h2 className="mb-4 border-l-[3px] border-vermilion pl-3 text-2xl font-bold tracking-wide text-vermilion">
                            {group}
                        </h2>
                        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                            {TOOL_PAGES.filter((t) => t.group === group).map((tool) => (
                                <Link
                                    key={tool.slug}
                                    href={`/tools/${tool.slug}`}
                                    className="lift-card block p-5 no-underline"
                                >
                                    <div className="mb-2 text-3xl leading-none" aria-hidden="true">
                                        {tool.icon}
                                    </div>
                                    <div className="mb-1.5 flex items-center gap-2">
                                        <h3 className="text-lg font-semibold text-ink">{tool.title}</h3>
                                        <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-secondary">
                                            规划中
                                        </span>
                                    </div>
                                    <p className="text-sm leading-relaxed text-secondary">{tool.intent}</p>
                                </Link>
                            ))}
                        </div>
                    </section>
                ))}
            </div>
        </LayoutWrapper>
    );
}
