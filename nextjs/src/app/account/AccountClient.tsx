'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMember } from '@/lib/use-member';
import LoginForm from '@/components/auth/LoginForm';
import { useSiteT } from '@/i18n/use-site-t';


export default function AccountClient() {
  const t = useSiteT();
  const router = useRouter();
  const { state, logout } = useMember();

  if (state.status === 'loading') return <div className="og-account"><p className="og-login-note">{t('nav.account.loading')}</p></div>;

  if (state.status === 'anon') {
    return (
      <div className="og-account">
        <h1>{t('nav.account.login')}</h1>
        <LoginForm next="/account" />
      </div>
    );
  }

  const m = state.member;
  const roleLabel = m.role === 'admin' ? t('nav.account.roles.admin') : m.role === 'editor' ? t('nav.account.roles.editor') : m.role === 'reviewer' ? t('nav.account.roles.reviewer') : t('nav.account.roles.reader');
  const joined = m.joinedAt ? new Date(m.joinedAt * (m.joinedAt < 1e12 ? 1000 : 1)).toLocaleDateString('zh-CN') : '—';
  return (
    <div className="og-account">
      <h1>{t('nav.account.my')}</h1>
      <dl className="og-account-list">
        <dt>{t('nav.account.email')}</dt>
        <dd>{m.email}</dd>
        <dt>{t('nav.account.role')}</dt>
        <dd>{roleLabel}</dd>
        <dt>{t('nav.account.joined')}</dt>
        <dd>{joined}</dd>
      </dl>
      <div className="og-account-actions">
        {m.role === 'admin' && <Link href="/admin" className="og-account-link">{t('nav.account.admin')}</Link>}
        <button type="button" className="og-login-btn" onClick={async () => { await logout(); router.push('/'); }}>
          {t('nav.account.logout')}
        </button>
      </div>
    </div>
  );
}
