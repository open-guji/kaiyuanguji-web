import FeatureBanner from './FeatureBanner';

export default function JoinSection() {
  return (
    <div id="join">
      <FeatureBanner
        tags={['代码贡献', '数据校对', '学术支持']}
        title="参与开发 - 汇聚技术力量守护文化根脉"
        description="项目尚处起步阶段，我们正在密集构建核心框架与标准。具体的参与方式（包括代码贡献、数据校对及学术支持）将很快在此公布。感谢您对中国古籍数字化事业的关注。"
        image={{ src: '/images/intelligence.webp', alt: '古籍知识图谱' }}
        action={{
          label: '关注 GitHub 进展',
          href: 'https://github.com/open-guji',
          external: true,
        }}
      />
    </div>
  );
}
