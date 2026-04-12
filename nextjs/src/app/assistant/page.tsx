import LayoutWrapper from '@/components/layout/LayoutWrapper';
import MarkdownPage from '@/components/markdown/MarkdownPage';
import { getMarkdownContent, extractTOC } from '@/lib/markdown';
import { Metadata } from 'next';

export const metadata: Metadata = {
  title: '古籍整理平台',
  description: '基于 VS Code 的一站式古籍数字化整理平台，覆盖从资源采集到排版发布的完整流程。',
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
