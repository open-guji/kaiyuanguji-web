'use client';

import { useSiteLocale } from '@/lib/site-locale';
import { getSiteT } from '@/i18n/translate';

/**
 * 顶栏右侧「繁／简」（用户 9-30 反馈，overview#322）：右上角依次是 繁简｜外观｜反馈。
 *
 * 偏好存在 lib/site-locale（不引组件库，静态页不被拖大）。用组件库的页面（目录、元数据、条目）
 * 经 BimLocaleProvider 跟着它走；本站自己的界面文字走 i18n 字典（useSiteT），切了也当场生效（overview#337）。
 * 「繁」「简」两个字形标的是两种字体本身，不进字典。
 */
export default function LocaleSwitch() {
  const [locale, setLocale] = useSiteLocale();
  const isHant = locale === 'zh-Hant';
  const t = getSiteT(locale);

  return (
    <button
      type="button"
      className="og-nav-btn og-locale"
      onClick={() => setLocale(isHant ? 'zh-Hans' : 'zh-Hant')}
      aria-label={t(isHant ? 'nav.locale.toHans' : 'nav.locale.toHant')}
    >
      <span aria-hidden="true" className={isHant ? 'is-on' : undefined}>繁</span>
      <span aria-hidden="true" className="og-locale-sep">/</span>
      <span aria-hidden="true" className={isHant ? undefined : 'is-on'}>简</span>
    </button>
  );
}
