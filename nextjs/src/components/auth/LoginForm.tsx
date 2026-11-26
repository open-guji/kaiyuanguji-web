'use client';

import { useState } from 'react';
import { useSiteT } from '@/i18n/use-site-t';

/** 邮箱登录／注册表单（顶栏下拉与 /register 共用）：发一封登录链接，无密码。 */
export default function LoginForm({ next, compact = false }: { next?: string | null; compact?: boolean }) {
  const t = useSiteT();
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'fail'>('idle');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState('sending');
    try {
      const safe = next && next.startsWith('/') && !next.startsWith('//') ? next : null;
      const cb = `/api/ba-session${safe ? `?next=${encodeURIComponent(safe)}` : ''}`;
      const res = await fetch('/api/ba/sign-in/magic-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), callbackURL: cb }),
      });
      setState(res.ok ? 'sent' : 'fail');
    } catch {
      setState('fail');
    }
  }

  if (state === 'sent') return <p className="og-login-note">{t('nav.account.sent')}</p>;
  return (
    <form onSubmit={submit} className={compact ? 'og-login og-login--compact' : 'og-login'}>
      <p className="og-login-note">{t('nav.account.hint')}</p>
      <input
        type="email"
        required
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@example.com"
        aria-label={t('nav.account.email')}
        className="og-login-input"
      />
      <button type="submit" disabled={state === 'sending'} className="og-login-btn">
        {state === 'sending' ? t('nav.account.sending') : t('nav.account.send')}
      </button>
      {state === 'fail' && <p className="og-login-err" role="alert">{t('nav.account.fail')}</p>}
    </form>
  );
}
