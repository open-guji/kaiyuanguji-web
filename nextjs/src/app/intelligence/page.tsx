import MarkdownPageContent from '@/components/markdown/MarkdownPageContent';
import { getMarkdownContent } from '@/lib/markdown';
import { Metadata } from 'next';

export async function generateMetadata(): Promise<Metadata> {
    const filename = 'intelligence';
    try {
        const { frontmatter } = await getMarkdownContent(filename);
        return {
            title: frontmatter.title || '知识图谱与 AI',
            description: frontmatter.description || '古籍知识图谱与大语言模型',
        };
    } catch {
        return { title: '知识图谱与 AI' };
    }
}

export default function IntelligencePage() {
    return <MarkdownPageContent filename="intelligence.md" />;
}
