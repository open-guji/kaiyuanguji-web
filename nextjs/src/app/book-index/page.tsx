import LayoutWrapper from '@/components/layout/LayoutWrapper';
import BookList from '@/components/book-index/BookList';
import { Metadata } from 'next';

export const metadata: Metadata = {
  title: '古籍索引',
  description: '浏览和搜索开源古籍数据库，发现传统文化的宝藏。',
};

export default function BookIndexPage() {
  return (
    <LayoutWrapper>
      <BookList />
    </LayoutWrapper>
  );
}
