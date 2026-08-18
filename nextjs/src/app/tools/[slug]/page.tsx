import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import LayoutWrapper from '@/components/layout/LayoutWrapper';
import ToolPlaceholder from '@/components/tools/ToolPlaceholder';
import { TOOL_PAGES } from '@/lib/constants';

interface ToolPageProps {
    params: Promise<{ slug: string }>;
}

export function generateStaticParams() {
    return TOOL_PAGES.map((t) => ({ slug: t.slug }));
}

export async function generateMetadata({ params }: ToolPageProps): Promise<Metadata> {
    const { slug } = await params;
    const tool = TOOL_PAGES.find((t) => t.slug === slug);
    if (!tool) return { title: '小工具' };
    return {
        title: tool.title,
        description: `${tool.title}（${tool.group}）— ${tool.intent}目前为规划中的占位页，功能尚未开放。`,
        alternates: { canonical: `/tools/${tool.slug}` },
    };
}

export default async function ToolPage({ params }: ToolPageProps) {
    const { slug } = await params;
    const tool = TOOL_PAGES.find((t) => t.slug === slug);
    if (!tool) notFound();

    return (
        <LayoutWrapper>
            <ToolPlaceholder tool={tool} />
        </LayoutWrapper>
    );
}
