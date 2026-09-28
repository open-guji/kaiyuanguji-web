'use client';

import { useRef, useState } from 'react';
import Navbar from './Navbar';
import MobileDrawer from './MobileDrawer';
import Footer from './Footer';
import { FeedbackProvider } from '../feedback/FeedbackProvider';
import { useReveal } from '../../lib/use-reveal';
import { MAIN_CONTENT_ID } from './nav-links';

interface LayoutWrapperProps {
  children: React.ReactNode;
  hideFooter?: boolean;
  /** 首页：页头透明浮在首屏大图上 */
  navOnHero?: boolean;
}

export default function LayoutWrapper({ children, hideFooter = false, navOnHero = false }: LayoutWrapperProps) {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  // 滚动进场动效（观察全站 .reveal 元素）
  useReveal();

  // 反馈入口在导航栏右侧（N7），弹窗由 FeedbackProvider 统一挂载；右下角浮钮已去掉
  return (
    <FeedbackProvider>
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
    </FeedbackProvider>
  );
}
