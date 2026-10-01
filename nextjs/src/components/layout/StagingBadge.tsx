import { IS_STAGING } from '@/lib/constants';

/**
 * T1 测试站角标：仅 NEXT_PUBLIC_SITE_ENV=staging 时渲染，正式站不出现。
 * 桌面固定在视口右上角，z-index 高于导航栏（sticky z-50），不占布局空间。
 * 手机端（overview#325）右上角正是汉堡键，角标压在上面看不见菜单入口；改放左下角，
 * 抬到 80px 高，让开阅读页底部工具条。
 * 字色用深琥珀（amber-950 #451a03）压在琥珀底（#fe9a00）上，对比度约 8:1；白字只有 2.13:1，
 * 会让 e2e 的 axe 门在每个页面都红（测试站独有，不随朱砂／靛蓝主题变）。
 */
export default function StagingBadge() {
  if (!IS_STAGING) return null;
  return (
    <div
      data-testid="staging-badge"
      className="pointer-events-none fixed bottom-20 left-2 z-[60] rounded-full md:bottom-auto md:left-auto md:right-2 md:top-2
                 bg-amber-500 px-2.5 py-1 text-xs font-bold text-amber-950 shadow-md"
    >
      测试站
    </div>
  );
}
