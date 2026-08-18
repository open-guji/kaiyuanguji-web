import Link from 'next/link';
import SectionHeader from './SectionHeader';

const features = [
  { icon: '📖', label: '作品' },
  { icon: '📚', label: '丛编' },
  { icon: '📕', label: '书籍' },
];

export default function BookIndexSection() {
  return (
    <section id="book-index" className="py-12 px-6 bg-paper">
      <div className="max-w-7xl mx-auto">
        <SectionHeader
          title="古籍索引"
          subtitle="标准化的古籍数字资源索引与版本管理系统"
        />

        <div className="max-w-[900px] mx-auto feature-card reveal p-8">
          {/* Mobile Layout */}
          <div className="md:hidden space-y-6">
            {/* Tags */}
            <div className="flex flex-wrap gap-2 text-sm text-vermilion font-medium">
              <span>作品</span>
              <span>·</span>
              <span>丛编</span>
              <span>·</span>
              <span>书籍</span>
            </div>

            {/* Description */}
            <p className="text-base md:text-lg text-ink leading-relaxed">
              古籍索引建立了标准化的 ID 体系，解决古籍数字化中的层级分类和版本关联问题。
              支持作品（Work）、丛编（Collection）、书（Book）三个层级，实现古籍资源的统一检索、版本追溯与关联管理。
              为古籍数字化项目提供可靠的元数据基础设施。
            </p>

            {/* Feature Chips */}
            <div className="flex flex-wrap gap-3">
              {features.map((feature) => (
                <div
                  key={feature.label}
                  className="px-3 py-1.5 bg-paper rounded-full border border-border
                           text-sm text-secondary flex items-center gap-2"
                >
                  <span>{feature.icon}</span>
                  <span>{feature.label}</span>
                </div>
              ))}
            </div>

            {/* Button */}
            <Link
              href="/book-index"
              className="w-full block text-center px-8 py-5 bg-vermilion text-white rounded-lg
                       font-medium hover:bg-vermilion/90 transition-colors"
            >
              浏览索引
            </Link>
          </div>

          {/* Desktop Layout */}
          <div className="hidden md:flex gap-10 items-center">
            {/* Left Content */}
            <div className="flex-1 space-y-4">
              {/* Tags */}
              <div className="flex flex-wrap gap-2 text-sm text-vermilion font-medium">
                <span>作品</span>
                <span>·</span>
                <span>丛编</span>
                <span>·</span>
                <span>书籍</span>
              </div>

              {/* Description */}
              <p className="text-lg text-ink leading-relaxed">
                古籍索引建立了标准化的 ID 体系，解决古籍数字化中的层级分类和版本关联问题。
                支持作品（Work）、丛编（Collection）、书（Book）三个层级，实现古籍资源的统一检索、版本追溯与关联管理。
                为古籍数字化项目提供可靠的元数据基础设施。
              </p>

              {/* Feature Chips */}
              <div className="flex flex-wrap gap-3">
                {features.map((feature) => (
                  <div
                    key={feature.label}
                    className="px-3 py-1.5 bg-paper rounded-full border border-border
                             text-sm text-secondary flex items-center gap-2"
                  >
                    <span>{feature.icon}</span>
                    <span>{feature.label}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Right Button */}
            <Link
              href="/book-index"
              className="px-8 py-5 bg-vermilion text-white rounded-lg font-medium
                       hover:bg-vermilion/90 transition-colors whitespace-nowrap"
            >
              浏览索引
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
