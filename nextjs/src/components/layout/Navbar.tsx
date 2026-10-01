'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { MOBILE_DRAWER_ID, PRIMARY_LINKS, isCurrent } from './nav-links';
import { useFeedback } from '../feedback/FeedbackProvider';
import AppearancePicker from './AppearancePicker';
import LocaleSwitch from './LocaleSwitch';
import { useSiteT } from '@/i18n/use-site-t';

interface NavbarProps {
  onMobileMenuToggle?: () => void;
  /** 抽屉是否打开（给汉堡按钮的 aria-expanded） */
  menuOpen?: boolean;
  /** 汉堡按钮的 ref：抽屉关闭后把焦点还给它 */
  menuButtonRef?: React.Ref<HTMLButtonElement>;
  /** 首页：页头透明，浮在坤舆图上 */
  onHero?: boolean;
}

/**
 * 顶栏（N1）：无底边线、无竖线分隔，当前项只用一条朱色下划线。
 * 右上角依次是 繁简｜外观｜反馈（用户 9-30 反馈，overview#322），所有页面一致。
 * 手机端收成右侧汉堡按钮（44×44）。
 * 右侧「反馈」（N7）：桌面是图标＋文字，手机只留图标；打开全站统一的反馈弹窗，
 * 条目页、阅读页会自动带上本页的条目与卷。
 */
export default function Navbar({ onMobileMenuToggle, menuOpen = false, menuButtonRef, onHero = false }: NavbarProps) {
  const pathname = usePathname();
  const { open: openFeedback } = useFeedback();
  const t = useSiteT();

  return (
    <header className={onHero ? 'og-nav og-nav--hero' : 'og-nav'}>
      <div className="og-nav-inner">
        <Link href="/" className="og-brand">
          <Image src="/images/open-guji-logo.webp" alt={t('nav.logoAlt')} width={26} height={26} />
          <span>{t('nav.brand')}</span>
        </Link>

        <nav aria-label={t('nav.primaryNav')}>
          <ul className="og-links">
            {PRIMARY_LINKS.map((l) => (
              <li key={l.href}>
                <Link href={l.href} aria-current={isCurrent(pathname, l.href) ? 'page' : undefined}>
                  {t(l.labelKey)}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="og-nav-right">
          <LocaleSwitch />
          <AppearancePicker />
          <button type="button" className="og-nav-fb" onClick={() => openFeedback()} aria-label={t('nav.feedback')} aria-haspopup="dialog">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M4 5.5h16v10H9l-5 4v-14z" />
            </svg>
            <span className="og-nav-fb-label" aria-hidden="true">{t('nav.feedback')}</span>
          </button>
          <button
            ref={menuButtonRef}
            type="button"
            onClick={onMobileMenuToggle}
            className="og-burger"
            aria-label={t('nav.openMenu')}
            aria-expanded={menuOpen}
            aria-controls={MOBILE_DRAWER_ID}
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          </button>
        </div>
      </div>
    </header>
  );
}
