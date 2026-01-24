'use client';

import { useState } from 'react';
import Navbar from './Navbar';
import MobileDrawer from './MobileDrawer';
import Footer from './Footer';

interface LayoutWrapperProps {
  children: React.ReactNode;
}

export default function LayoutWrapper({ children }: LayoutWrapperProps) {
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  return (
    <>
      <Navbar onMobileMenuToggle={() => setIsMobileMenuOpen(true)} />
      <MobileDrawer
        isOpen={isMobileMenuOpen}
        onClose={() => setIsMobileMenuOpen(false)}
      />
      <main className="min-h-[calc(100vh-theme(spacing.16))] bg-paper">
        {children}
      </main>
      <Footer />
    </>
  );
}
