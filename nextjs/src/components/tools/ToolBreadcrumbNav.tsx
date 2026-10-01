'use client';

import type { ReactNode } from 'react';
import { useSiteT } from '@/i18n';

/** 面包屑导航：aria-label 是属性，服务端组件里用不了 <T>，单独做成小客户端组件跟随繁简偏好 */
export default function ToolBreadcrumbNav({ className, children }: { className?: string; children: ReactNode }) {
  const t = useSiteT();
  return (
    <nav className={className} aria-label={t('pages.tools.placeholder.breadcrumbAria')}>
      {children}
    </nav>
  );
}
