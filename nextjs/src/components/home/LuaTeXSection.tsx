import SectionHeader from './SectionHeader';

export default function LuaTeXSection() {
  return (
    <section id="luatex" className="py-12 px-6 bg-white">
      <div className="max-w-7xl mx-auto">
        <SectionHeader
          title="LuaTeX-cn - 古籍排版"
          subtitle="基于 LuaTeX 引擎实现高质量中文古籍排版"
        />

        <div className="max-w-[900px] mx-auto bg-white rounded-2xl p-8 border border-border/50 shadow-lg">
          <div className="flex flex-col md:flex-row gap-10 items-center">
            {/* Left Content */}
            <div className="flex-1 space-y-4">
              {/* Tags */}
              <div className="flex flex-wrap gap-2 text-sm text-vermilion font-medium">
                <span>竖排排版</span>
                <span>·</span>
                <span>版心装饰</span>
                <span>·</span>
                <span>夹注侧批</span>
              </div>

              {/* Description */}
              <p className="text-lg text-ink leading-relaxed">
                LuaTeX-CN 致力于基于 LuaTeX 引擎实现最纯粹、最高质量的中文排版支持。
                已完整覆盖竖排核心逻辑、版心装饰及夹注处理，能够精确复刻《史记》《红楼梦》等古籍版式。
                支持横排/竖排、古籍/现代版式。
              </p>

              {/* Links */}
              <div className="flex flex-wrap gap-4 text-sm">
                <a
                  href="https://github.com/open-guji/luatex-cn"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-vermilion hover:underline flex items-center gap-1"
                >
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                  </svg>
                  GitHub
                </a>
                <span className="text-border">|</span>
                <a
                  href="https://gitee.com/open-guji/luatex-cn"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-vermilion hover:underline"
                >
                  Gitee 镜像（国内访问）
                </a>
              </div>
            </div>

            {/* Right Button */}
            <a
              href="https://github.com/open-guji/luatex-cn"
              target="_blank"
              rel="noopener noreferrer"
              className="px-8 py-5 bg-vermilion text-white rounded-lg font-medium
                       hover:bg-vermilion/90 transition-colors whitespace-nowrap"
            >
              查看项目
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
