import LayoutWrapper from '@/components/layout/LayoutWrapper';
import MarkdownPage from '@/components/markdown/MarkdownPage';
import { getMarkdownContent, extractTOC } from '@/lib/markdown';
import { Metadata } from 'next';
import { notFound } from 'next/navigation';

interface ReadPageProps {
  params: Promise<{ filename: string }>;
}

export async function generateMetadata({
  params,
}: ReadPageProps): Promise<Metadata> {
  const { filename } = await params;
  const decodedFilename = decodeURIComponent(filename).replace(/\.md$/, '');

  try {
    const { frontmatter } = await getMarkdownContent(decodedFilename);
    return {
      title: frontmatter.title || decodedFilename,
      description: frontmatter.description || `阅读《${decodedFilename}》`,
    };
  } catch {
    return {
      title: decodedFilename,
      description: `阅读《${decodedFilename}》`,
    };
  }
}

export default async function ReadPage({ params }: ReadPageProps) {
  const { filename } = await params;
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
    notFound();
  }
}
