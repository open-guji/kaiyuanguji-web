import Image from 'next/image';

const ethos = [
  {
    title: '专业排版',
    description: '利用 LuaTeX 引擎深度还原古籍版式，精准支持竖排、版心装饰与双行小注。',
  },
  {
    title: '信息提取',
    description: '集成前沿古籍 OCR 与版面分析模型，实现古籍图像到结构化文本的自动提取。',
  },
  {
    title: '校对工具',
    description: '提供高效的图文对照与异体字映射协作环境，保障高质量的典藏数字化。',
  },
  {
    title: '智能训练',
    description: '构建古籍深度知识系统，训练专用古籍 AI 大模型，辅助学者进行智慧研究。',
  },
];

export default function EthosSection() {
  return (
    <>
      {/* 长卷横幅：赵孟頫书《太上老君说常清静经》（元，弗利尔美术馆藏） */}
      <div className="scroll-strip anim-fade-in anim-delay-2 relative h-[170px]">
        <Image
          src="/images/changqing-jingjing.webp"
          alt=""
          aria-hidden="true"
          fill
          sizes="100vw"
          className="object-cover"
          style={{ filter: 'sepia(0.12)' }}
        />
      </div>

      {/* 四条主张 */}
      <section className="bg-paper px-6 py-12">
        <div
          className="reveal reveal-stagger mx-auto grid max-w-7xl gap-8
                     [grid-template-columns:repeat(auto-fit,minmax(270px,1fr))]"
        >
          {ethos.map((item) => (
            <div key={item.title} className="lift-card px-7 py-9 text-center">
              <h3 className="mb-3 text-xl font-semibold text-ink">{item.title}</h3>
              <p className="text-base leading-relaxed text-secondary">
                {item.description}
              </p>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
