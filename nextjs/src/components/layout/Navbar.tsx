'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { useState } from 'react';

const navItems = [
  { label: '首页', href: '/' },
  { label: '路线图', href: '/roadmap' },
  { label: '古籍助手', href: '/assistant' },
  { label: '古籍索引', href: '/book-index' },
  { label: '参与开发', href: '#join' },
];

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
    <header className="sticky top-0 z-50 bg-paper border-b border-border">
      <nav className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between">
          {/* Logo and Title */}
          <Link href="/" className="flex items-center gap-3 hover:opacity-80 transition-opacity">
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

          {/* Desktop Navigation */}
          <div className="hidden md:flex items-center gap-2">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={(e) => handleAnchorClick(e, item.href)}
                className={`
                  px-4 py-2 text-sm tracking-wide transition-colors rounded-md
                  ${
                    isActive(item.href)
                      ? 'text-vermilion font-bold'
                      : 'text-ink hover:text-vermilion'
                  }
                `}
              >
                {item.label}
              </Link>
            ))}
          </div>

          {/* Mobile Menu Button */}
          <button
            onClick={onMobileMenuToggle}
            className="md:hidden p-2 text-ink hover:text-vermilion transition-colors"
            aria-label="打开菜单"
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
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
        </div>
      </nav>
    </header>
  );
}
