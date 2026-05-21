import LayoutWrapper from '@/components/layout/LayoutWrapper';
import ErrorLogContent from './ErrorLogContent';
import { Metadata } from 'next';

// 管理端错误日志页：靠 ?token= 鉴权，禁止搜索引擎索引。
export const metadata: Metadata = {
  title: '错误日志',
  robots: { index: false, follow: false },
};

export default function ErrorLogPage() {
  return (
    <LayoutWrapper>
      <ErrorLogContent />
    </LayoutWrapper>
  );
}
