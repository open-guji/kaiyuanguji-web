'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { MORE_LINKS, PRIMARY_LINKS, isCurrent } from './nav-links';

interface MobileDrawerProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * 手机抽屉（N1）：主导航 + 「更多」（顶栏拿下来的现网入口）。
 * 每行 ≥ 44px；当前项用朱色字和浅朱底，不再用左侧竖条。
 */
export default function MobileDrawer({ isOpen, onClose }: MobileDrawerProps) {
  const pathname = usePathname();

  // 抽屉打开时锁定页面滚动
  useEffect(() => {
    document.body.style.overflow = isOpen ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  // Esc 关闭
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const row = (l: { label: string; href: string }) => (
    <Link
      key={l.href}
      href={l.href}
      onClick={onClose}
      aria-current={isCurrent(pathname, l.href) ? 'page' : undefined}
    >
      {l.label}
    </Link>
  );

  return (
    <>
      <div className="og-drawer-mask" onClick={onClose} aria-hidden="true" />
      <aside className="og-drawer" aria-label="移动端菜单">
        <div className="og-drawer-head">
          <Link href="/" onClick={onClose} className="og-brand">
            <Image src="/images/open-guji-logo.webp" alt="开源古籍 Logo" width={26} height={26} />
            <span>开源古籍</span>
          </Link>
          <button type="button" onClick={onClose} className="og-burger" style={{ display: 'inline-flex' }} aria-label="关闭菜单">
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
              <path d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <nav className="og-drawer-body" aria-label="移动端导航">
          {PRIMARY_LINKS.map(row)}
          <p className="og-drawer-cap">更多</p>
          {MORE_LINKS.map(row)}
        </nav>
      </aside>
    </>
  );
}
