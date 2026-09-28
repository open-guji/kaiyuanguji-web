'use client';

import { useRef, useState } from 'react';
import Navbar from '@/components/layout/Navbar';
import MobileDrawer from '@/components/layout/MobileDrawer';
import FeedbackWidget from '@/components/common/FeedbackWidget';
import { useReveal } from '@/lib/use-reveal';
import { MAIN_CONTENT_ID } from '@/components/layout/nav-links';
import SampleFooter from './SampleFooter';

/** 样张用的外壳：与 LayoutWrapper 相同，只把页脚换成 N6 样张页脚。顶栏、抽屉归 N7，不动。 */
export default function SampleShell({ children, navOnHero = false }: { children: React.ReactNode; navOnHero?: boolean }) {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  useReveal();

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
      <MobileDrawer isOpen={isMobileMenuOpen} onClose={() => setIsMobileMenuOpen(false)} returnFocusRef={menuButtonRef} />
      <main id={MAIN_CONTENT_ID} tabIndex={-1} className="min-h-[calc(100vh-var(--nav-h))] outline-none">
        {children}
      </main>
      <SampleFooter />
      <div className="og-fab-space" aria-hidden="true" />
      {!isMobileMenuOpen && <FeedbackWidget />}
    </>
  );
}
