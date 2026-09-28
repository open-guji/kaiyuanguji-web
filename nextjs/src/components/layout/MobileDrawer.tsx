'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { MOBILE_DRAWER_ID, MORE_LINKS, PRIMARY_LINKS, isCurrent } from './nav-links';

interface MobileDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  /** 关闭后把焦点还给谁（汉堡按钮） */
  returnFocusRef?: React.RefObject<HTMLElement | null>;
}

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * 手机抽屉（N1）：主导航 + 「更多」（顶栏拿下来的现网入口）。
 * 每行 ≥ 44px；当前项用朱色字和浅朱底，不再用左侧竖条。
 *
 * 无障碍（B9）：模态对话框。打开时焦点移进来并困在里面（Tab / Shift+Tab 循环），
 * Esc 或点遮罩关闭，关闭后焦点还给汉堡按钮。
 */
export default function MobileDrawer({ isOpen, onClose, returnFocusRef }: MobileDrawerProps) {
  const pathname = usePathname();
  const panelRef = useRef<HTMLElement>(null);

  // 抽屉打开时锁定页面滚动
  useEffect(() => {
    document.body.style.overflow = isOpen ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  // 焦点：打开时移进抽屉，关闭（卸载）时还给汉堡按钮
  useEffect(() => {
    if (!isOpen) return;
    const returnTo = returnFocusRef?.current;
    // 先落在「关闭」上：读屏先听到怎么退出
    panelRef.current?.querySelector<HTMLElement>('.og-burger--close')?.focus();
    return () => returnTo?.focus();
  }, [isOpen, returnFocusRef]);

  // Esc 关闭；Tab 困在抽屉里
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !panelRef.current.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !panelRef.current.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
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
      <aside
        ref={panelRef}
        id={MOBILE_DRAWER_ID}
        className="og-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="站点菜单"
      >
        <div className="og-drawer-head">
          <Link href="/" onClick={onClose} className="og-brand">
            <Image src="/images/open-guji-logo.webp" alt="开源古籍 Logo" width={26} height={26} />
            <span>开源古籍</span>
          </Link>
          <button type="button" onClick={onClose} className="og-burger og-burger--close" aria-label="关闭菜单">
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
