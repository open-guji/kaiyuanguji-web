import SectionHeader from './SectionHeader';

export default function AssistantSection() {
  return (
    <section className="py-12 px-6 bg-[#F7F9F9]">
      <div className="max-w-7xl mx-auto">
        <SectionHeader
          title="古籍助手"
          subtitle="基于大模型的智能科研辅助工具"
        />

        <div className="max-w-[900px] mx-auto bg-white rounded-2xl p-8 border border-border/50 shadow-lg">
          <div className="flex flex-col md:flex-row gap-10 items-center">
            {/* Left Content */}
            <div className="flex-1 space-y-4">
              {/* Tags */}
              <div className="flex flex-wrap gap-2 text-sm text-vermilion font-medium">
                <span>核心集成</span>
                <span>·</span>
                <span>全端协同</span>
                <span>·</span>
                <span>开放源码</span>
              </div>

              {/* Description */}
              <p className="text-lg text-ink leading-relaxed">
                古籍助手是本项目所有技术成果的统一集成门户。它深度整合了 OCR 识别、校对工具及
                AI 分析等一系列核心能力，提供 Web 与桌面端多端支持，致力于构建人人可用的开源数字人文环境。
              </p>
            </div>

            {/* Right Button */}
            <a
              href="https://toolkit.kaiyuanguji.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="px-8 py-5 bg-ink text-white rounded-lg font-medium
                       hover:bg-ink/90 transition-colors whitespace-nowrap"
            >
              立即使用
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
