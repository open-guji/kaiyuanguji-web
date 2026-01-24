import LayoutWrapper from '@/components/layout/LayoutWrapper';
import MarkdownPage from '@/components/markdown/MarkdownPage';
import { getMarkdownContent, extractTOC } from '@/lib/markdown';
import { notFound } from 'next/navigation';

interface MarkdownPageContentProps {
    filename: string;
}

export default async function MarkdownPageContent({ filename }: MarkdownPageContentProps) {
    const decodedFilename = decodeURIComponent(filename).replace(/\.md$/, '');

    try {
        const { content, frontmatter } = await getMarkdownContent(decodedFilename);
        const toc = extractTOC(content);

        return (
            <LayoutWrapper>
                <MarkdownPage
                    content={content}
                    toc={toc}
                    title={frontmatter.title}
                />
            </LayoutWrapper>
        );
    } catch (error) {
        console.error(`Failed to load markdown content for: ${decodedFilename}`, error);
        notFound();
    }
}
