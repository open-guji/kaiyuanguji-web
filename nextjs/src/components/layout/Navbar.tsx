'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import SourceToggle from '../common/SourceToggle';
import { NAV_ITEMS } from '../../lib/constants';

interface NavbarProps {
  onMobileMenuToggle?: () => void;
}

export default function Navbar({ onMobileMenuToggle }: NavbarProps) {
  const pathname = usePathname();

  const isActive = (href: string) => {
    if (href === '/') {
      return pathname === '/';
    }
    return pathname.startsWith(href);
  };

  const handleAnchorClick = (e: React.MouseEvent, href: string) => {
    if (href.startsWith('#')) {
      e.preventDefault();
      const targetId = href.substring(1);
      const targetElement = document.getElementById(targetId);
      if (targetElement) {
        targetElement.scrollIntoView({ behavior: 'smooth' });
      }
    }
  };

  return (
    <header className="sticky top-0 z-50 bg-[var(--color-nav-bg)] border-b border-[var(--color-nav-border)]">
      <nav className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-10 items-center justify-between">
          {/* Logo and Title */}
          <Link href="/" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
            <Image
              src="/images/open-guji-logo.png"
              alt="开源古籍 Logo"
              width={24}
              height={24}
              className="h-6 w-6"
            />
            <span className="text-sm font-semibold text-[var(--color-nav-ink)] tracking-wide">
              开源古籍
            </span>
          </Link>

          {/* Desktop Navigation */}
          <div className="hidden md:flex items-center gap-4">
            <div className="flex items-center gap-2">
              {NAV_ITEMS.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={(e) => handleAnchorClick(e, item.href)}
                  className={`
                    px-3 py-1 text-xs tracking-wide transition-colors rounded-md
                    ${isActive(item.href)
                      ? 'text-[var(--color-nav-vermilion)] font-bold'
                      : 'text-[var(--color-nav-ink)] hover:text-[var(--color-nav-vermilion)]'
                    }
                  `}
                >
                  {item.label}
                </Link>
              ))}
            </div>

            <div className="h-3 w-[1px] bg-[var(--color-nav-border)] mx-1" />
            <SourceToggle />
          </div>

          {/* Mobile Menu Button + Toggle */}
          <div className="flex items-center gap-2 md:hidden">
            <SourceToggle />
            <button
              onClick={onMobileMenuToggle}
              className="p-2 text-[var(--color-nav-ink)] hover:text-[var(--color-nav-vermilion)] transition-colors"
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
