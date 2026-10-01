'use client';

import { useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useSiteT, type SiteMessageKey } from '@/i18n';

type Info = { valid: boolean; email?: string | null; role?: string; reason?: string; expires?: number };

// 错误存键而不是存文字：本地的提示随繁简切换；接口回的 error 原样显示（overview#337）
type ShownError = { key: SiteMessageKey } | { raw: string };
class KeyedError extends Error {
  constructor(public key: SiteMessageKey) { super(key); }
}
const toShown = (e: unknown): ShownError =>
  e instanceof KeyedError ? { key: e.key } : { raw: e instanceof Error ? e.message : String(e) };

export default function JoinClient() {
  const sp = useSearchParams();
  const router = useRouter();
  const t = useSiteT();
  const code = sp.get('c') || '';
  const [info, setInfo] = useState<Info | null>(null);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<ShownError | null>(null);
  const [emailInput, setEmailInput] = useState('');

  useEffect(() => {
    if (!code) { setLoading(false); setError({ key: 'pages.join.missingCode' }); return; }
    fetch(`/api/auth/invite-info?c=${encodeURIComponent(code)}&cb=${Date.now()}`)
      .then(r => r.json())
      .then(j => {
        if (!j.success) throw j.error ? new Error(j.error) : new KeyedError('pages.join.queryFailed');
        setInfo(j);
        if (j.email) setEmailInput(j.email);
      })
      .catch(e => setError(toShown(e)))
      .finally(() => setLoading(false));
  }, [code]);

  async function handleJoin() {
    if (!code) return;
    setJoining(true);
    setError(null);
    try {
      const body: any = { code };
      if (info && !info.email) {
        if (!emailInput || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailInput)) throw new KeyedError('pages.join.invalidEmail');
        body.email = emailInput.trim().toLowerCase();
      }
      const res = await fetch('/api/auth/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await res.json();
      if (!j.success) throw j.error ? new Error(j.error) : new KeyedError('pages.join.joinFailed');
      router.push('/');
      router.refresh();
    } catch (e) {
      setError(toShown(e));
    } finally {
      setJoining(false);
    }
  }

  const errorText = error ? ('key' in error ? t(error.key) : error.raw) : null;

  if (loading) return <div className="max-w-xl mx-auto p-8 text-center">{t('pages.join.loading')}</div>;
  if (error && !info) return <div className="max-w-xl mx-auto p-8 text-center text-red-600">{errorText}</div>;
  if (info && !info.valid) {
    const msg = t(info.reason === 'used' ? 'pages.join.codeUsed' : info.reason === 'expired' ? 'pages.join.codeExpired' : 'pages.join.codeInvalid');
    return <div className="max-w-xl mx-auto p-8 text-center"><p className="text-red-600">{msg}</p><p className="text-sm text-gray-500 mt-2">{t('pages.join.askAdmin')}</p></div>;
  }

  return (
    <div className="max-w-xl mx-auto p-8">
      <h1 className="text-2xl font-bold mb-4">{t('pages.join.title')}</h1>
      <p className="mb-4 text-gray-700">
        {info?.email ? <>{t('pages.join.joinAsBefore')}<span className="font-mono font-semibold">{info.email}</span>{t('pages.join.joinAsAfter')}</> : t('pages.join.enterEmail')}
        {info?.role ? <>（<span className="font-semibold">{info.role}</span>）</> : null}
      </p>
      {info && !info.email && (
        <input className="w-full border rounded px-3 py-2 mb-4" placeholder="your@email.com" value={emailInput} onChange={e => setEmailInput(e.target.value)} />
      )}
      {error && <p className="text-red-600 text-sm mb-3">{errorText}</p>}
      <button onClick={handleJoin} disabled={joining} className="w-full bg-black text-white rounded py-2 disabled:opacity-50">
        {joining ? t('pages.join.joining') : t('pages.join.confirm')}
      </button>
      <p className="text-xs text-gray-400 mt-4">{t('pages.join.cookieNote')}</p>
    </div>
  );
}
