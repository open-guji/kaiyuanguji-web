import { IS_STAGING } from '@/lib/constants';

/**
 * T1 测试站角标：仅 NEXT_PUBLIC_SITE_ENV=staging 时渲染，正式站不出现。
 * 固定在视口右上角，z-index 高于导航栏（sticky z-50），不占布局空间。
 */
export default function StagingBadge() {
  if (!IS_STAGING) return null;
  return (
    <div
      data-testid="staging-badge"
      className="pointer-events-none fixed right-2 top-2 z-[60] rounded-full
                 bg-amber-500 px-2.5 py-1 text-xs font-bold text-white shadow-md"
    >
      测试站
    </div>
  );
}
