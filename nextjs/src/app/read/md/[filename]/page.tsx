import { Metadata } from 'next';
import fs from 'fs';
import path from 'path';
import MarkdownPageContent from '@/components/markdown/MarkdownPageContent';
import { getMarkdownContent } from '@/lib/markdown';

// 说明页（public/content/*.md）。阅读页搬到 /read/<id> 后这些页挪到 /read/md/<名>，旧的 /read/<名> 见 lib/markdown-pages.ts。
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
        canonical: `/read/md/${filename}`,
      },
      openGraph: {
        title,
        description,
        type: 'article',
        url: `/read/md/${filename}`,
      },
    };
  } catch {
    return {
      title: decodedFilename,
      description: `阅读《${decodedFilename}》`,
      alternates: {
        canonical: `/read/md/${filename}`,
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
      .flatMap((file) => [
        { filename: file },
        { filename: file.replace(/\.md$/, '') },
      ]);
  } catch (error) {
    console.error('Failed to read content directory for static params:', error);
    return [];
  }
}

export default async function ReadPage({ params }: ReadPageProps) {
  const { filename } = await params;
  return <MarkdownPageContent filename={filename} />;
}
