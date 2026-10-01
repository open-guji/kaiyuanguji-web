'use client';

import { useState } from 'react';
import Link from 'next/link';
import { HOME_FEATURES } from './features';

/**
 * 首页「我们在做的事」卡片列表。
 * 手机端（overview#325）：六张卡一张一行要划一千多像素，其中四张是「规划中」、没有入口；
 * 默认只露已上线的两张，规划中的收成一行「还有 N 项规划中：…」，点开再看。
 * 收起只在 max-width: 760px 下生效（globals.css），桌面三列照旧全显示、这个按钮不出现。
 */
export default function HomeFeatures() {
  const [collapsed, setCollapsed] = useState(true);
  const planned = HOME_FEATURES.filter((f) => !f.live);

  return (
    <>
      <ul id="home-features" className="home-features" data-collapsed={collapsed || undefined}>
        {HOME_FEATURES.map((f, i) => (
          <li key={f.title} className={f.live ? 'home-feature is-live' : 'home-feature'}>
            <span className="num" aria-hidden="true">
              {String(i + 1).padStart(2, '0')}
            </span>
            <h3>
              {f.title}
              <span className={f.live ? 'status is-live' : 'status'}>{f.live ? '已上线' : '规划中'}</span>
            </h3>
            <p>{f.text}</p>
            {f.cta && (
              <Link className="home-feature-cta" href={f.cta.href}>
                {f.cta.label} <span aria-hidden="true">→</span>
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
                还有 {planned.length} 项规划中：{planned.map((f) => f.title).join('、')}
              </span>
              <span className="home-features-more-act">展开</span>
            </>
          ) : (
            <span className="home-features-more-act">收起规划中的 {planned.length} 项</span>
          )}
        </button>
      )}
    </>
  );
}
