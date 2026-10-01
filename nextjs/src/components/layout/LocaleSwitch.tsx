'use client';

import { useSiteLocale } from '@/lib/site-locale';

/**
 * 顶栏右侧「繁／简」（用户 9-30 反馈，overview#322）：右上角依次是 繁简｜外观｜反馈。
 *
 * 偏好存在 lib/site-locale（不引组件库，静态页不被拖大）。用组件库的页面（目录、元数据、条目）
 * 经 BimLocaleProvider 跟着它走，切了当场生效；本站自己的静态页（首页、关于）文字本是简体，只记下偏好。
 */
export default function LocaleSwitch() {
  const [locale, setLocale] = useSiteLocale();
  const isHant = locale === 'zh-Hant';

  return (
    <button
      type="button"
      className="og-nav-btn og-locale"
      onClick={() => setLocale(isHant ? 'zh-Hans' : 'zh-Hant')}
      aria-label={isHant ? '繁/简（当前繁体，点击切换为简体）' : '繁/简（当前简体，点击切换为繁体）'}
    >
      <span aria-hidden="true" className={isHant ? 'is-on' : undefined}>繁</span>
      <span aria-hidden="true" className="og-locale-sep">/</span>
      <span aria-hidden="true" className={isHant ? undefined : 'is-on'}>简</span>
    </button>
  );
}
