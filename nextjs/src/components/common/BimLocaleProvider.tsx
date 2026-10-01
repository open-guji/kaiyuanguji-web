'use client';

import { LocaleProvider } from 'book-index-ui';
import { useSiteLocale } from '@/lib/site-locale';

/**
 * 组件库的 LocaleProvider，接成受控、跟着全站繁简偏好（lib/site-locale）走：
 * 顶栏「繁／简」切了，页面里组件库渲染的文字当场跟着变；组件库内部自带的切换按钮切了，也同步回全站。
 */
export default function BimLocaleProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocale] = useSiteLocale();
  return (
    <LocaleProvider locale={locale} onLocaleChange={setLocale}>
      {children}
    </LocaleProvider>
  );
}
