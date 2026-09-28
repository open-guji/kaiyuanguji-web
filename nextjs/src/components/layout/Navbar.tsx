'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { PRIMARY_LINKS, isCurrent } from './nav-links';

interface NavbarProps {
  onMobileMenuToggle?: () => void;
  /** 首页：页头透明，浮在坤舆图上 */
  onHero?: boolean;
}

/**
 * 顶栏（N1）：无底边线、无竖线分隔，当前项只用一条朱色下划线。
 * 手机端收成右侧汉堡按钮（44×44）。
 */
export default function Navbar({ onMobileMenuToggle, onHero = false }: NavbarProps) {
  const pathname = usePathname();

  return (
    <header className={onHero ? 'og-nav og-nav--hero' : 'og-nav'}>
      <div className="og-nav-inner">
        <Link href="/" className="og-brand">
          <Image src="/images/open-guji-logo.webp" alt="开源古籍 Logo" width={26} height={26} />
          <span>开源古籍</span>
        </Link>

        <nav aria-label="主导航">
          <ul className="og-links">
            {PRIMARY_LINKS.map((l) => (
              <li key={l.href}>
                <Link href={l.href} aria-current={isCurrent(pathname, l.href) ? 'page' : undefined}>
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="og-nav-right">
          <button type="button" onClick={onMobileMenuToggle} className="og-burger" aria-label="打开菜单">
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
