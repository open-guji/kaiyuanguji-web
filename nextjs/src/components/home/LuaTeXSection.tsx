import FeatureBanner from './FeatureBanner';

export default function LuaTeXSection() {
  return (
    <div id="luatex">
      <FeatureBanner
        tags={['竖排排版', '版心装饰', '夹注侧批']}
        title="LuaTeX-cn - 古籍专业排版引擎"
        description="LuaTeX-CN 致力于基于 LuaTeX 引擎实现最纯粹、最高质量的中文古籍排版支持。已完整覆盖竖排核心逻辑、版心装饰及夹注处理，能够精确复刻《史记》《红楼梦》等经典古籍版式。"
        image={{ src: '/images/typesetting.webp', alt: '古籍竖排版式示例' }}
        action={{
          label: '前往 GitHub 了解专案',
          href: 'https://github.com/open-guji/luatex-cn',
          external: true,
        }}
      >
        <p className="mb-6 text-sm text-secondary">
          <a
            href="https://gitee.com/open-guji/luatex-cn"
            target="_blank"
            rel="noopener noreferrer"
            className="text-vermilion hover:underline"
          >
            Gitee 镜像（国内访问）
          </a>
        </p>
      </FeatureBanner>
    </div>
  );
}
