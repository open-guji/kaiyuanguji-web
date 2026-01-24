import LayoutWrapper from '@/components/layout/LayoutWrapper';
import { Metadata } from 'next';

export const metadata: Metadata = {
  title: '路线图',
  description: '开源古籍项目发展路线图，了解项目的过去、现在和未来。',
};

export default function RoadmapPage() {
  return (
    <LayoutWrapper>
      <div className="flex flex-col items-center justify-center min-h-[60vh] px-4">
        <h1 className="text-4xl font-bold text-ink mb-4">项目路线图</h1>
        <p className="text-secondary text-lg">项目发展路线图即将展示</p>
      </div>
    </LayoutWrapper>
  );
}
