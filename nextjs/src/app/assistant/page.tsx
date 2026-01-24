import LayoutWrapper from '@/components/layout/LayoutWrapper';
import MarkdownPage from '@/components/markdown/MarkdownPage';
import { getMarkdownContent, extractTOC } from '@/lib/markdown';
import { Metadata } from 'next';

export const metadata: Metadata = {
  title: '古籍助手',
  description: '智能古籍助手，帮助你更好地理解和学习古籍。',
};

export default async function AssistantPage() {
  const { content } = await getMarkdownContent('assistant');
  const toc = extractTOC(content);

  return (
    <LayoutWrapper>
      <MarkdownPage content={content} toc={toc} />
    </LayoutWrapper>
  );
}
