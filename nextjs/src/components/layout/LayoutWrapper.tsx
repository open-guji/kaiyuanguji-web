'use client';

import { useState } from 'react';
import Navbar from './Navbar';
import MobileDrawer from './MobileDrawer';
import Footer from './Footer';
import FeedbackWidget from '../common/FeedbackWidget';
import { useReveal } from '../../lib/use-reveal';

interface LayoutWrapperProps {
  children: React.ReactNode;
  hideFooter?: boolean;
  hideFeedbackButton?: boolean;
}

export default function LayoutWrapper({ children, hideFooter = false, hideFeedbackButton = false }: LayoutWrapperProps) {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  // 滚动进场动效（观察全站 .reveal 元素）
  useReveal();

  return (
    <>
      <Navbar onMobileMenuToggle={() => setIsMobileMenuOpen(true)} />
      <MobileDrawer
        isOpen={isMobileMenuOpen}
        onClose={() => setIsMobileMenuOpen(false)}
      />
      <main className="min-h-[calc(100vh-3.5rem)]">
        {children}
      </main>
      {!hideFooter && <Footer />}
      {!hideFeedbackButton && <FeedbackWidget />}
    </>
  );
}
