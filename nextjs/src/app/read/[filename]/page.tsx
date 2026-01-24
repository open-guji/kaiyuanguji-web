import LayoutWrapper from '@/components/layout/LayoutWrapper';
import { Metadata } from 'next';

interface ReadPageProps {
  params: Promise<{ filename: string }>;
}

export async function generateMetadata({
  params,
}: ReadPageProps): Promise<Metadata> {
  const { filename } = await params;
  const title = decodeURIComponent(filename).replace(/\.md$/, '');

  return {
    title,
    description: `阅读《${title}》`,
  };
}

export default async function ReadPage({ params }: ReadPageProps) {
  const { filename } = await params;
  const title = decodeURIComponent(filename).replace(/\.md$/, '');

  return (
    <LayoutWrapper>
      <div className="flex flex-col items-center justify-center min-h-[60vh] px-4">
        <h1 className="text-4xl font-bold text-ink mb-4">{title}</h1>
        <p className="text-secondary text-lg">Markdown 内容渲染即将实现</p>
      </div>
    </LayoutWrapper>
  );
}
