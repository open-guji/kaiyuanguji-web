'use client';

import Link from 'next/link';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useMember } from '@/lib/use-member';
import LoginForm from '../auth/LoginForm';
import { useSiteT } from '@/i18n/use-site-t';

/**
 * 顶栏右侧账号入口：未登录是「登录」按钮，点开在下方弹出邮箱登录框；
 * 登录后换成人形图标，点它进 /account（基本信息与登出）。
 */
export default function AccountMenu() {
  const t = useSiteT();
  const { state } = useMember();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) btnRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(true); }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  if (state.status === 'loading') return <span className="og-acct og-acct--ph" aria-hidden="true" />;

  if (state.status === 'member') {
    return (
      <Link href="/account" className="og-acct-icon" aria-label={t('nav.account.my')} title={state.member.email}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="8" r="4" />
          <path d="M4.5 20c.8-3.6 3.9-5.5 7.5-5.5s6.7 1.9 7.5 5.5" />
        </svg>
      </Link>
    );
  }

  return (
    <span className="og-acct" ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className="og-acct-btn"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
      >
        {t('nav.account.login')}
      </button>
      {open && (
        <div className="og-acct-panel" id={panelId} role="dialog" aria-label={t('nav.account.login')}>
          <LoginForm compact />
        </div>
      )}
    </span>
  );
}
