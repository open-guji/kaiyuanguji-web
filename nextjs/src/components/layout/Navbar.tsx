'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import SourceToggle from '../common/SourceToggle';
import { NAV_ITEMS, type NavItem } from '../../lib/constants';

interface NavbarProps {
  onMobileMenuToggle?: () => void;
}

const linkBase = 'px-3 py-1.5 text-sm tracking-wide rounded-md transition-colors no-underline';

const activeCls =
  'text-[var(--color-nav-vermilion)] font-bold bg-[color-mix(in_srgb,var(--color-nav-vermilion)_10%,transparent)]';

const idleCls =
  'text-[var(--color-nav-ink)] hover:text-[var(--color-nav-vermilion)] hover:bg-[color-mix(in_srgb,var(--color-nav-vermilion)_8%,transparent)]';

/**
 * 带下拉的导航项。
 * 展开走 CSS group-hover / group-focus-within，键盘 Tab 也能展开，无需 JS 状态。
 */
function DropdownNavItem({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <li className="group relative">
      <Link
        href={item.href}
        className={`${linkBase} inline-flex items-center gap-1 ${active ? activeCls : idleCls}`}
      >
        {item.label}
        <span
          aria-hidden="true"
          className="text-[0.6rem] transition-transform duration-200 group-hover:rotate-180"
        >
          ▼
        </span>
      </Link>

      <ul
        className="invisible absolute left-0 top-full z-50 min-w-[13rem] translate-y-2.5 list-none
                   rounded-md border border-[var(--color-nav-border)] bg-[var(--color-surface)]
                   py-1.5 opacity-0 shadow-[var(--shadow-soft)] transition-all duration-200
                   group-hover:visible group-hover:translate-y-1 group-hover:opacity-100
                   group-focus-within:visible group-focus-within:translate-y-1 group-focus-within:opacity-100"
      >
        {item.children?.map((child, i) => {
          // 同一 group 的第一项前面插入分组标题（如「词典」「韵书」）
          const showGroup = child.group && child.group !== item.children?.[i - 1]?.group;
          return (
            <li key={child.href}>
              {showGroup && (
                <div className="px-5 pb-1 pt-2 text-[11px] font-bold tracking-wider text-[var(--color-secondary)]">
                  {child.group}
                </div>
              )}
              <Link
                href={child.href}
                className={`block whitespace-nowrap py-2 text-sm leading-snug no-underline
                           text-[var(--color-nav-ink)]
                           hover:bg-[color-mix(in_srgb,var(--color-nav-vermilion)_10%,transparent)]
                           hover:text-[var(--color-nav-vermilion)]
                           ${child.group ? 'pl-7 pr-5' : 'px-5'}`}
              >
                {child.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </li>
  );
}

export default function Navbar({ onMobileMenuToggle }: NavbarProps) {
  const pathname = usePathname();

  const matches = (href: string) =>
    href === '/' ? pathname === '/' : pathname.startsWith(href);

  /** 父级在自身或任一子项命中时高亮 */
  const isActive = (item: NavItem) =>
    matches(item.href) || (item.children?.some((c) => matches(c.href)) ?? false);

  return (
    <header
      className="sticky top-0 z-50 border-b-2 border-[var(--color-nav-border)]
                 bg-[color-mix(in_srgb,var(--color-nav-bg)_92%,transparent)]
                 backdrop-blur-[10px]"
    >
      <nav className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-14 items-center gap-4">
          {/* Logo */}
          <Link
            href="/"
            className="flex shrink-0 items-center gap-2 no-underline transition-opacity hover:opacity-80"
          >
            <Image
              src="/images/open-guji-logo.webp"
              alt="开源古籍 Logo"
              width={28}
              height={28}
              className="h-7 w-7"
            />
            <span className="text-lg font-bold tracking-[0.2em] text-[var(--color-nav-ink)]">
              开源古籍
            </span>
          </Link>

          {/* 桌面端导航：标签页居左，紧随 Logo */}
          <ul className="hidden list-none items-center gap-1 md:flex">
            {NAV_ITEMS.map((item) =>
              item.children?.length ? (
                <DropdownNavItem key={item.href} item={item} active={isActive(item)} />
              ) : (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className={`${linkBase} ${isActive(item) ? activeCls : idleCls}`}
                  >
                    {item.label}
                  </Link>
                </li>
              )
            )}
          </ul>

          {/* 右侧操作区 */}
          <div className="ml-auto flex items-center gap-2">
            <SourceToggle />

            <button
              onClick={onMobileMenuToggle}
              className="p-2 text-[var(--color-nav-ink)] transition-colors
                         hover:text-[var(--color-nav-vermilion)] md:hidden"
              aria-label="打开菜单"
            >
              <svg
                className="h-5 w-5"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
          </div>
        </div>
      </nav>
    </header>
  );
}
