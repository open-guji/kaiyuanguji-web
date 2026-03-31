import LayoutWrapper from '@/components/layout/LayoutWrapper';
import FeedbackPageContent from './FeedbackPageContent';
import { Metadata } from 'next';

export const metadata: Metadata = {
  title: '用户反馈',
  description: '查看开源古籍项目的用户反馈与处理进展。',
};

export default function FeedbackPage() {
  return (
    <LayoutWrapper>
      <FeedbackPageContent />
    </LayoutWrapper>
  );
}
