import FeatureBanner from './FeatureBanner';

export default function BookIndexSection() {
  return (
    <div id="book-index">
      <FeatureBanner
        tags={[
          <span key="w">📖 作品 Work</span>,
          <span key="c">📚 丛编 Collection</span>,
          <span key="b">📕 书籍 Book</span>,
        ]}
        title="标准化古籍数字资源索引系统"
        description="建立标准化的 ID 体系，解决古籍数字化中的层级分类和版本关联问题。支持作品（Work）、丛编（Collection）、书（Book）三个层级，实现跨馆藏古籍资源的统一检索、版本追溯与关联管理。"
        image={{ src: '/images/gudiwang-tujuan.webp', alt: '历代帝王图卷（唐·阎立本绘）' }}
        action={{ label: '进入古籍索引总目', href: '/book-index' }}
      />
    </div>
  );
}
