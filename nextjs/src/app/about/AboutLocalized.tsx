'use client';

import type { ComponentProps, ReactNode } from 'react';
import { useSiteT, type SiteMessageKey } from '@/i18n';

/**
 * 关于页是服务端组件，属性里的界面文字（aria-label、alt）用不了 <T>，放这几个小客户端组件里跟随繁简偏好（overview#337）。
 */
export function LabeledNav({ labelKey, className, children }: { labelKey: SiteMessageKey; className?: string; children: ReactNode }) {
  const t = useSiteT();
  return (
    <nav className={className} aria-label={t(labelKey)}>
      {children}
    </nav>
  );
}

export function LocalizedImg({ altKey, ...props }: Omit<ComponentProps<'img'>, 'alt'> & { altKey: SiteMessageKey }) {
  const t = useSiteT();
  // eslint-disable-next-line @next/next/no-img-element
  return <img {...props} alt={t(altKey)} />;
}
