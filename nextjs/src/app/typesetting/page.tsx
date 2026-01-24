import MarkdownPageContent from '@/components/markdown/MarkdownPageContent';
import { getMarkdownContent } from '@/lib/markdown';
import { Metadata } from 'next';

export async function generateMetadata(): Promise<Metadata> {
    const filename = 'typesetting';
    try {
        const { frontmatter } = await getMarkdownContent(filename);
        return {
            title: frontmatter.title || '古籍排版',
            description: frontmatter.description || '基于 LaTeX/typst 的古籍排版工具',
        };
    } catch {
        return { title: '古籍排版' };
    }
}

export default function TypesettingPage() {
    return <MarkdownPageContent filename="typesetting.md" />;
}
