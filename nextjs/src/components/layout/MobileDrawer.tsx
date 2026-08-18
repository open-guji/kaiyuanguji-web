'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { NAV_ITEMS, type NavItem } from '../../lib/constants';

const NAV_ICONS: Record<string, string> = {
  '/': '🏠',
  '/book-index': '📚',
  '/assistant': '🛠️',
  '/roadmap': '🗺️',
  '/tools': '🧰',
  '/feedback': '💬',
};

interface MobileDrawerProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function MobileDrawer({ isOpen, onClose }: MobileDrawerProps) {
  const pathname = usePathname();
  const [expanded, setExpanded] = useState<string | null>(null);

  // 抽屉打开时锁定页面滚动
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  const matches = (href: string) =>
    href === '/' ? pathname === '/' : pathname.startsWith(href);

  const isActive = (item: NavItem) =>
    matches(item.href) || (item.children?.some((c) => matches(c.href)) ?? false);

  // 打开时自动展开命中当前路由的分组
  useEffect(() => {
    if (!isOpen) return;
    const hit = NAV_ITEMS.find((i) => i.children?.length && isActive(i));
    setExpanded(hit?.href ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, pathname]);

  if (!isOpen) return null;

  const rowBase =
    'flex items-center gap-3 px-6 py-3 text-sm tracking-wide transition-colors border-l-4 no-underline w-full text-left';

  const rowActive =
    'border-[var(--color-nav-vermilion)] text-[var(--color-nav-vermilion)] font-bold bg-[color-mix(in_srgb,var(--color-nav-vermilion)_6%,transparent)]';

  const rowIdle =
    'border-transparent text-[var(--color-nav-ink)] hover:text-[var(--color-nav-vermilion)] hover:bg-[color-mix(in_srgb,var(--color-nav-border)_25%,transparent)]';

  return (
    <>
      {/* 遮罩层 */}
      <div
        className="fixed inset-0 z-40 bg-black/50 md:hidden"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* 抽屉（右侧滑入，与设计稿一致） */}
      <aside
        className="fixed bottom-0 right-0 top-0 z-50 flex w-80 max-w-[85vw] flex-col
                   bg-[var(--color-nav-bg)] shadow-2xl md:hidden"
        aria-label="移动端菜单"
      >
        {/* 头部 */}
        <div className="border-b border-[var(--color-nav-border)] p-6">
          <div className="flex items-center justify-between">
            <Link href="/" onClick={onClose} className="flex items-center gap-3 no-underline">
              <Image
                src="/images/open-guji-logo.webp"
                alt="开源古籍 Logo"
                width={32}
                height={32}
                className="h-8 w-8"
              />
              <span className="text-lg font-bold tracking-[0.15em] text-[var(--color-nav-ink)]">
                开源古籍
              </span>
            </Link>
            <button
              onClick={onClose}
              className="p-2 text-[var(--color-nav-ink)] transition-colors hover:text-[var(--color-nav-vermilion)]"
              aria-label="关闭菜单"
            >
              <svg
                className="h-6 w-6"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="2"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* 导航项 */}
        <nav className="flex-1 overflow-y-auto py-4">
          {NAV_ITEMS.map((item) => {
            const active = isActive(item);
            const icon = NAV_ICONS[item.href] || '📄';

            if (!item.children?.length) {
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={onClose}
                  className={`${rowBase} ${active ? rowActive : rowIdle}`}
                >
                  <span className="text-xl" aria-hidden="true">
                    {icon}
                  </span>
                  <span>{item.label}</span>
                </Link>
              );
            }

            const open = expanded === item.href;
            return (
              <div key={item.href}>
                <button
                  type="button"
                  onClick={() => setExpanded(open ? null : item.href)}
                  aria-expanded={open}
                  className={`${rowBase} ${active ? rowActive : rowIdle}`}
                >
                  <span className="text-xl" aria-hidden="true">
                    {icon}
                  </span>
                  <span>{item.label}</span>
                  <span
                    aria-hidden="true"
                    className={`ml-auto text-[0.65rem] transition-transform duration-200 ${
                      open ? 'rotate-180' : ''
                    }`}
                  >
                    ▼
                  </span>
                </button>

                {open && (
                  <div className="bg-[color-mix(in_srgb,var(--color-nav-border)_18%,transparent)]">
                    {/* 分组总览页本身也要能进入 */}
                    <Link
                      href={item.href}
                      onClick={onClose}
                      className={`block py-2.5 pl-[4.25rem] pr-6 text-sm no-underline transition-colors ${
                        matches(item.href) && pathname === item.href
                          ? 'font-bold text-[var(--color-nav-vermilion)]'
                          : 'text-[var(--color-nav-ink)] hover:text-[var(--color-nav-vermilion)]'
                      }`}
                    >
                      {item.label}总览
                    </Link>
                    {item.children.map((child, i) => {
                      const showGroup =
                        child.group && child.group !== item.children?.[i - 1]?.group;
                      return (
                        <div key={child.href}>
                          {showGroup && (
                            <div className="pl-[4.25rem] pr-6 pb-0.5 pt-2 text-[11px] font-bold tracking-wider text-[var(--color-secondary)]">
                              {child.group}
                            </div>
                          )}
                          <Link
                            href={child.href}
                            onClick={onClose}
                            className={`block py-2.5 pr-6 text-sm no-underline transition-colors ${
                              child.group ? 'pl-[5.25rem]' : 'pl-[4.25rem]'
                            } ${
                              matches(child.href)
                                ? 'font-bold text-[var(--color-nav-vermilion)]'
                                : 'text-[var(--color-nav-ink)] hover:text-[var(--color-nav-vermilion)]'
                            }`}
                          >
                            {child.label}
                          </Link>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        {/* 底部信息 */}
        <div className="border-t border-[var(--color-nav-border)] p-6 text-center">
          <p className="text-sm leading-relaxed text-[var(--color-nav-ink)]/60">
            开源古籍项目
          </p>
          <p className="mt-1 text-xs text-[var(--color-nav-ink)]/40">
            让古籍数字化更简单
          </p>
        </div>
      </aside>
    </>
  );
}
