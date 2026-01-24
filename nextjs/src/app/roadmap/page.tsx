import LayoutWrapper from '@/components/layout/LayoutWrapper';
import MarkdownPage from '@/components/markdown/MarkdownPage';
import { getMarkdownContent, extractTOC } from '@/lib/markdown';
import { Metadata } from 'next';

export const metadata: Metadata = {
  title: '路线图',
  description: '开源古籍项目发展路线图，了解项目的过去、现在和未来。',
};

export default async function RoadmapPage() {
  const { content } = await getMarkdownContent('roadmap_overview');
  const toc = extractTOC(content);

  return (
    <LayoutWrapper>
      <MarkdownPage content={content} toc={toc} />
    </LayoutWrapper>
  );
}
