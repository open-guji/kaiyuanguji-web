import MarkdownPageContent from '@/components/markdown/MarkdownPageContent';
import { getMarkdownContent } from '@/lib/markdown';
import { Metadata } from 'next';

export async function generateMetadata(): Promise<Metadata> {
    const filename = 'storage';
    try {
        const { frontmatter } = await getMarkdownContent(filename);
        return {
            title: frontmatter.title || '开源存储',
            description: frontmatter.description || '古籍资源的开源存储与检索',
        };
    } catch {
        return { title: '开源存储' };
    }
}

export default function StoragePage() {
    return <MarkdownPageContent filename="storage.md" />;
}
