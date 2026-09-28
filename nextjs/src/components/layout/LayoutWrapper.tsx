'use client';

import { useRef, useState } from 'react';
import Navbar from './Navbar';
import MobileDrawer from './MobileDrawer';
import Footer from './Footer';
import FeedbackWidget from '../common/FeedbackWidget';
import { useReveal } from '../../lib/use-reveal';
import { MAIN_CONTENT_ID } from './nav-links';

interface LayoutWrapperProps {
  children: React.ReactNode;
  hideFooter?: boolean;
  hideFeedbackButton?: boolean;
  /** 首页：页头透明浮在首屏大图上 */
  navOnHero?: boolean;
}

export default function LayoutWrapper({ children, hideFooter = false, hideFeedbackButton = false, navOnHero = false }: LayoutWrapperProps) {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  // 滚动进场动效（观察全站 .reveal 元素）
  useReveal();

  // 浮动反馈钮：抽屉打开时不渲染（A2），否则盖在抽屉上抢焦点
  const showFab = !hideFeedbackButton && !isMobileMenuOpen;

  return (
    <>
      <a href={`#${MAIN_CONTENT_ID}`} className="og-skip">
        跳到正文
      </a>
      <Navbar
        onHero={navOnHero}
        menuOpen={isMobileMenuOpen}
        menuButtonRef={menuButtonRef}
        onMobileMenuToggle={() => setIsMobileMenuOpen(true)}
      />
      <MobileDrawer
        isOpen={isMobileMenuOpen}
        onClose={() => setIsMobileMenuOpen(false)}
        returnFocusRef={menuButtonRef}
      />
      <main id={MAIN_CONTENT_ID} tabIndex={-1} className="min-h-[calc(100vh-var(--nav-h))] outline-none">
        {children}
      </main>
      {!hideFooter && <Footer />}
      {/* 给浮钮留出等高的底部留白，免得它盖住页面最后一行（页脚的备案号等） */}
      {!hideFeedbackButton && <div className="og-fab-space" aria-hidden="true" />}
      {showFab && <FeedbackWidget />}
    </>
  );
}
