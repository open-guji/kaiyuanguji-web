import LayoutWrapper from '@/components/layout/LayoutWrapper';
import { Metadata } from 'next';

export const metadata: Metadata = {
  title: '古籍助手',
  description: '智能古籍助手，帮助你更好地理解和学习古籍。',
};

export default function AssistantPage() {
  return (
    <LayoutWrapper>
      <div className="flex flex-col items-center justify-center min-h-[60vh] px-4">
        <h1 className="text-4xl font-bold text-ink mb-4">古籍助手</h1>
        <p className="text-secondary text-lg">智能古籍助手功能即将上线</p>
      </div>
    </LayoutWrapper>
  );
}
