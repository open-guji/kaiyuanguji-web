import SectionHeader from './SectionHeader';
import RoadmapCard from './RoadmapCard';

const roadmapCards = [
  {
    title: '专业排版',
    description: '利用 LaTeX 引擎深度还原古籍之美，支持纵排、双行小注等复杂版式',
    image: '/images/typesetting.png',
    slug: 'typesetting',
  },
  {
    title: '信息提取',
    description: '集成最先进的古籍 OCR 与版面分析模型，实现文字与结构的自动化提取',
    image: '/images/ocr.png',
    slug: 'extraction',
  },
  {
    title: '校对工具',
    description: '提供图文对照、异体字映射的高效率协作环境，确保古籍数字化的准确性',
    image: '/images/toolkit.png',
    slug: 'toolkit',
  },
  {
    title: '储存检索',
    description: '采用标准 XML/TEI 格式存储，建立可深度搜索的古籍全文数据库',
    image: '/images/hero.png',
    slug: 'storage',
  },
  {
    title: '智能训练',
    description: '构建深度知识系统，训练专用 AI 大模型，推动古籍数字化走向智能化研究',
    image: '/images/intelligence.png',
    slug: 'intelligence',
  },
];

export default function RoadmapSection() {
  return (
    <section id="roadmap" className="py-12 px-6 bg-paper">
      <div className="max-w-7xl mx-auto">
        <SectionHeader
          title="路线图"
          subtitle="从古籍数字化到智能化的技术路径"
          href="/roadmap"
        />

        {/* Desktop: 3 + 2 layout */}
        <div className="hidden tablet:block">
          {/* First Row: 3 cards */}
          <div className="grid grid-cols-3 gap-6 mb-6">
            {roadmapCards.slice(0, 3).map((card) => (
              <RoadmapCard key={card.slug} {...card} />
            ))}
          </div>

          {/* Second Row: 2 cards centered */}
          <div className="flex justify-center gap-6">
            {roadmapCards.slice(3, 5).map((card) => (
              <div key={card.slug} className="w-[calc(33.333%-16px)]">
                <RoadmapCard {...card} />
              </div>
            ))}
          </div>
        </div>

        {/* Mobile: Single column */}
        <div className="tablet:hidden space-y-6">
          {roadmapCards.map((card) => (
            <RoadmapCard key={card.slug} {...card} />
          ))}
        </div>
      </div>
    </section>
  );
}
