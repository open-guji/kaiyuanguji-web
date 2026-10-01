'use client';

import { useState } from 'react';
import Link from 'next/link';
import { HOME_FEATURES } from './features';
import { useSiteT } from '@/i18n/use-site-t';

/**
 * 首页「我们在做的事」卡片列表。
 * 手机端（overview#325）：六张卡一张一行要划一千多像素，其中四张是「规划中」、没有入口；
 * 默认只露已上线的两张，规划中的收成一行「还有 N 项规划中：…」，点开再看。
 * 收起只在 max-width: 760px 下生效（globals.css），桌面三列照旧全显示、这个按钮不出现。
 */
export default function HomeFeatures() {
  const t = useSiteT();
  const [collapsed, setCollapsed] = useState(true);
  const planned = HOME_FEATURES.filter((f) => !f.live);

  return (
    <>
      <ul id="home-features" className="home-features" data-collapsed={collapsed || undefined}>
        {HOME_FEATURES.map((f, i) => (
          <li key={f.id} className={f.live ? 'home-feature is-live' : 'home-feature'}>
            <span className="num" aria-hidden="true">
              {String(i + 1).padStart(2, '0')}
            </span>
            <h3>
              {t(f.titleKey)}
              <span className={f.live ? 'status is-live' : 'status'}>{t(f.live ? 'home.live' : 'home.planned')}</span>
            </h3>
            <p>{t(f.textKey)}</p>
            {f.cta && (
              <Link className="home-feature-cta" href={f.cta.href}>
                {t(f.cta.labelKey)} <span aria-hidden="true">→</span>
              </Link>
            )}
          </li>
        ))}
      </ul>
      {planned.length > 0 && (
        <button
          type="button"
          className="home-features-more"
          aria-expanded={!collapsed}
          aria-controls="home-features"
          onClick={() => setCollapsed((c) => !c)}
        >
          {collapsed ? (
            <>
              <span className="home-features-more-list">
                {t('home.plannedMore', {
                  count: planned.length,
                  list: planned.map((f) => t(f.titleKey)).join(t('home.plannedSep')),
                })}
              </span>
              <span className="home-features-more-act">{t('home.expand')}</span>
            </>
          ) : (
            <span className="home-features-more-act">{t('home.collapse', { count: planned.length })}</span>
          )}
        </button>
      )}
    </>
  );
}
