import { Metadata } from 'next';
import fs from 'fs';
import path from 'path';
import MarkdownPageContent from '@/components/markdown/MarkdownPageContent';
import { getMarkdownContent } from '@/lib/markdown';

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
    const title = frontmatter.title || decodedFilename;
    const description = frontmatter.description || `阅读《${decodedFilename}》`;

    return {
      title,
      description,
      alternates: {
        canonical: `/read/${filename}`,
      },
      openGraph: {
        title,
        description,
        type: 'article',
        url: `/read/${filename}`,
      },
    };
  } catch {
    return {
      title: decodedFilename,
      description: `阅读《${decodedFilename}》`,
      alternates: {
        canonical: `/read/${filename}`,
      },
    };
  }
}

export async function generateStaticParams() {
  const contentDir = path.join(process.cwd(), 'public/content');
  try {
    const files = fs.readdirSync(contentDir);
    return files
      .filter((file) => file.endsWith('.md'))
      .map((file) => ({
        filename: file,
      }));
  } catch (error) {
    console.error('Failed to read content directory for static params:', error);
    return [];
  }
}

export default async function ReadPage({ params }: ReadPageProps) {
  const { filename } = await params;
  return <MarkdownPageContent filename={filename} />;
}
