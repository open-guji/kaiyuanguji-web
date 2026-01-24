'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { useEffect } from 'react';

const navItems = [
  { label: '首页', href: '/', icon: '🏠' },
  { label: '路线图', href: '/roadmap', icon: '🗺️' },
  { label: '古籍助手', href: '/assistant', icon: '✨' },
  { label: '古籍索引', href: '/book-index', icon: '📚' },
  { label: '参与开发', href: '#join', icon: '🔧' },
];

interface MobileDrawerProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function MobileDrawer({ isOpen, onClose }: MobileDrawerProps) {
  const pathname = usePathname();

  // Lock body scroll when drawer is open
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

  const isActive = (href: string) => {
    if (href === '/') {
      return pathname === '/';
    }
    return pathname.startsWith(href);
  };

  const handleLinkClick = (e: React.MouseEvent, href: string) => {
    if (href.startsWith('#')) {
      e.preventDefault();
      const targetId = href.substring(1);
      const targetElement = document.getElementById(targetId);
      if (targetElement) {
        targetElement.scrollIntoView({ behavior: 'smooth' });
      }
    }
    onClose();
  };

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 z-40 md:hidden"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Drawer */}
      <aside
        className="fixed top-0 left-0 bottom-0 w-80 max-w-[85vw] bg-paper z-50 md:hidden
                   shadow-2xl transform transition-transform duration-300 ease-in-out
                   flex flex-col"
        aria-label="移动端菜单"
      >
        {/* Header */}
        <div className="p-6 border-b border-border">
          <div className="flex items-center justify-between">
            <Link href="/" onClick={onClose} className="flex items-center gap-3">
              <Image
                src="/images/open-guji-logo.png"
                alt="开源古籍 Logo"
                width={32}
                height={32}
                className="h-8 w-8"
              />
              <span className="text-lg font-semibold text-ink tracking-wide">
                开源古籍
              </span>
            </Link>
            <button
              onClick={onClose}
              className="p-2 text-ink hover:text-vermilion transition-colors"
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

        {/* Navigation Items */}
        <nav className="flex-1 overflow-y-auto py-4">
          {navItems.map((item) => {
            const active = isActive(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={(e) => handleLinkClick(e, item.href)}
                className={`
                  flex items-center gap-3 px-6 py-3 text-sm tracking-wide
                  transition-colors border-l-4
                  ${
                    active
                      ? 'border-vermilion text-vermilion font-bold bg-vermilion/5'
                      : 'border-transparent text-ink hover:text-vermilion hover:bg-border/20'
                  }
                `}
              >
                <span className="text-xl" aria-hidden="true">
                  {item.icon}
                </span>
                <span>{item.label}</span>
              </Link>
            );
          })}
        </nav>

        {/* Footer Info */}
        <div className="p-6 border-t border-border text-center">
          <p className="text-sm text-secondary leading-relaxed">
            开源古籍项目
          </p>
          <p className="text-xs text-secondary/70 mt-1">
            让古籍数字化更简单
          </p>
        </div>
      </aside>
    </>
  );
}
