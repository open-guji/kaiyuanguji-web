import SectionHeader from './SectionHeader';

export default function JoinSection() {
  return (
    <section id="join" className="py-12 px-6 bg-paper border-t border-border/50">
      <div className="max-w-7xl mx-auto">
        <SectionHeader
          title="参与开发"
          subtitle="汇聚技术力量，共同守护文化根脉"
        />

        <div className="max-w-[700px] mx-auto bg-white rounded-2xl p-8 shadow-lg">
          <div className="flex flex-col items-center gap-6 text-center">
            {/* Icon */}
            <div className="w-16 h-16 flex items-center justify-center">
              <svg
                className="w-16 h-16 text-vermilion"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
              </svg>
            </div>

            {/* Title */}
            <h3 className="text-lg font-semibold text-ink">
              项目尚处起步阶段
            </h3>

            {/* Description */}
            <div className="space-y-4 text-base text-ink leading-loose">
              <p>
                我们正在密集构建核心框架与标准。具体的参与方式（包括代码贡献、数据校对及学术支持）将很快在此公布。
              </p>
              <p>感谢您对中国古籍数字化事业的关注。</p>
            </div>

            {/* Button */}
            <a
              href="https://github.com/open-guji"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-8 py-4 bg-ink text-white rounded-lg
                       font-medium hover:bg-ink/90 transition-colors"
            >
              <svg
                className="w-5 h-5"
                fill="currentColor"
                viewBox="0 0 24 24"
              >
                <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
              </svg>
              <span>关注 GitHub 进展</span>
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
