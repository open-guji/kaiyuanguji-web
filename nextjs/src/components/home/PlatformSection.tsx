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
              <div className="flex flex-wrap gap-2 text-sm text-vermilion font-medium">
                <span>VS Code 扩展</span>
                <span>·</span>
                <span>本地优先</span>
                <span>·</span>
                <span>工具集成</span>
              </div>

              {/* Description */}
              <p className="text-lg text-ink leading-relaxed">
                古籍平台是一个基于 VS Code 的扩展，提供古籍数字化全流程工具集成。
                集成 OCR 识别、文本校对、排版预览等核心功能，让研究者在熟悉的编辑器中完成从识别到排版的完整工作流程。
                本地优先架构，确保数据安全与处理效率。
              </p>
            </div>

            {/* Right Button */}
            <a
              href="https://github.com/open-guji/guji-platform"
              target="_blank"
              rel="noopener noreferrer"
              className="px-8 py-5 bg-ink text-white rounded-lg font-medium
                       hover:bg-ink/90 transition-colors whitespace-nowrap"
            >
              查看项目
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
