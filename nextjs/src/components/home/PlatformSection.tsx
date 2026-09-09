import FeatureBanner from './FeatureBanner';

export default function PlatformSection() {
  return (
    <FeatureBanner
      tags={[
        'VS Code 扩展',
        '本地优先',
        '工具集成',
        <span
          key="wip"
          className="rounded bg-[color-mix(in_srgb,var(--color-accent-gold)_16%,transparent)]
                     px-2 py-0.5 text-xs text-[#8a6320]"
        >
          正在开发中
        </span>,
      ]}
      title="VS Code 一站式古籍整理平台"
      description="基于 VS Code 的扩展插件，提供古籍数字化全流程工具集成。将 OCR 识别、文本校对、排版预览集成到研究者熟悉的编辑器中，采用本地优先架构，确保研究数据的安全与高效处理。"
      image={{ src: '/images/toolkit.webp', alt: '古籍校对工具界面' }}
      disabledLabel="正在密集开发中"
    />
  );
}
