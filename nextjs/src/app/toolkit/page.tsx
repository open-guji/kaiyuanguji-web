import MarkdownPageContent from '@/components/markdown/MarkdownPageContent';
import { getMarkdownContent } from '@/lib/markdown';
import { Metadata } from 'next';

export async function generateMetadata(): Promise<Metadata> {
    const filename = 'toolkit';
    try {
        const { frontmatter } = await getMarkdownContent(filename);
        return {
            title: frontmatter.title || '数字化工具箱',
            description: frontmatter.description || '古籍数字化辅助工具',
        };
    } catch {
        return { title: '数字化工具箱' };
    }
}

export default function ToolkitPage() {
    return <MarkdownPageContent filename="toolkit.md" />;
}
