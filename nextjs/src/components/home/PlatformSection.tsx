import SectionHeader from './SectionHeader';

export default function PlatformSection() {
  return (
    <section className="py-12 px-6 bg-white">
      <div className="max-w-7xl mx-auto">
        <SectionHeader
          title="古籍平台"
          subtitle="基于 VS Code 的一站式古籍数字化工作平台"
        />

        <div className="max-w-[900px] mx-auto bg-white rounded-2xl p-8 border border-border/50 shadow-lg">
          <div className="flex flex-col md:flex-row gap-10 items-center">
            {/* Left Content */}
            <div className="flex-1 space-y-4">
              {/* Tags */}
              <div className="flex flex-wrap gap-2 text-sm font-medium">
                <span className="text-vermilion">VS Code 扩展</span>
                <span className="text-vermilion">·</span>
                <span className="text-vermilion">本地优先</span>
                <span className="text-vermilion">·</span>
                <span className="text-vermilion">工具集成</span>
                <span className="text-vermilion">·</span>
                <span className="px-2 py-0.5 bg-orange-100 text-orange-600 rounded text-xs">正在开发中</span>
              </div>

              {/* Description */}
              <p className="text-lg text-ink leading-relaxed">
                古籍平台是一个基于 VS Code 的扩展，提供古籍数字化全流程工具集成。
                集成 OCR 识别、文本校对、排版预览等核心功能，让研究者在熟悉的编辑器中完成从识别到排版的完整工作流程。
                本地优先架构，确保数据安全与处理效率。
              </p>
            </div>

            {/* Right Button - Disabled */}
            <button
              disabled
              className="px-8 py-5 bg-secondary/20 text-secondary rounded-lg font-medium
                       cursor-not-allowed whitespace-nowrap"
            >
              开发中
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
