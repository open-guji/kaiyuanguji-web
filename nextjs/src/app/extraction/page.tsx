import MarkdownPageContent from '@/components/markdown/MarkdownPageContent';
import { getMarkdownContent } from '@/lib/markdown';
import { Metadata } from 'next';

export async function generateMetadata(): Promise<Metadata> {
    const filename = 'extraction';
    try {
        const { frontmatter } = await getMarkdownContent(filename);
        return {
            title: frontmatter.title || '信息提取',
            description: frontmatter.description || 'OCR 与版面分析技术',
        };
    } catch {
        return { title: '信息提取' };
    }
}

export default function ExtractionPage() {
    return <MarkdownPageContent filename="extraction.md" />;
}
