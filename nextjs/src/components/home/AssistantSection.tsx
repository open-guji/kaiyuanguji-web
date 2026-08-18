import SectionHeader from './SectionHeader';

export default function AssistantSection() {
  return (
    <section className="py-12 px-6 bg-[#F7F9F9]">
      <div className="max-w-7xl mx-auto">
        <SectionHeader
          title="古籍整理平台"
          subtitle="基于 VS Code 的一站式古籍数字化整理工具"
        />

        <div className="max-w-[900px] mx-auto feature-card reveal p-8">
          <div className="flex flex-col md:flex-row gap-10 items-center">
            {/* Left Content */}
            <div className="flex-1 space-y-4">
              {/* Tags */}
              <div className="flex flex-wrap gap-2 text-sm text-vermilion font-medium">
                <span>七阶段流程</span>
                <span>·</span>
                <span>智能 OCR</span>
                <span>·</span>
                <span>AI 辅助</span>
                <span>·</span>
                <span>开放源码</span>
              </div>

              {/* Description */}
              <p className="text-lg text-ink leading-relaxed">
                古籍整理平台是一个 VS Code 插件，覆盖从资源采集、OCR 识别、文本校对到排版发布的完整七阶段流程。
                集成 14+ 资源站适配器、PaddleOCR 引擎和多种 AI 服务，让古籍数字化工作变得高效而规范。
              </p>
            </div>

            {/* Right Button */}
            <a
              href="/assistant"
              className="px-8 py-5 bg-ink text-white rounded-lg font-medium
                       hover:bg-ink/90 transition-colors whitespace-nowrap"
            >
              了解更多
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
