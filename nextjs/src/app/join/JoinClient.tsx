'use client';

import { useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';

type Info = { valid: boolean; email?: string | null; role?: string; reason?: string; expires?: number };

export default function JoinClient() {
  const sp = useSearchParams();
  const router = useRouter();
  const code = sp.get('c') || '';
  const [info, setInfo] = useState<Info | null>(null);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emailInput, setEmailInput] = useState('');

  useEffect(() => {
    if (!code) { setLoading(false); setError('缺少邀请码'); return; }
    fetch(`/api/auth/invite-info?c=${encodeURIComponent(code)}&cb=${Date.now()}`)
      .then(r => r.json())
      .then(j => {
        if (!j.success) throw new Error(j.error || '查询失败');
        setInfo(j);
        if (j.email) setEmailInput(j.email);
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [code]);

  async function handleJoin() {
    if (!code) return;
    setJoining(true);
    setError(null);
    try {
      const body: any = { code };
      if (info && !info.email) {
        if (!emailInput || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailInput)) throw new Error('请填写正确邮箱');
        body.email = emailInput.trim().toLowerCase();
      }
      const res = await fetch('/api/auth/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await res.json();
      if (!j.success) throw new Error(j.error || '加入失败');
      router.push('/');
      router.refresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setJoining(false);
    }
  }

  if (loading) return <div className="max-w-xl mx-auto p-8 text-center">加载中…</div>;
  if (error && !info) return <div className="max-w-xl mx-auto p-8 text-center text-red-600">{error}</div>;
  if (info && !info.valid) {
    const msg = info.reason === 'used' ? '邀请码已使用' : info.reason === 'expired' ? '邀请码已过期' : '邀请码无效';
    return <div className="max-w-xl mx-auto p-8 text-center"><p className="text-red-600">{msg}</p><p className="text-sm text-gray-500 mt-2">请联系管理员重新获取邀请链接</p></div>;
  }

  return (
    <div className="max-w-xl mx-auto p-8">
      <h1 className="text-2xl font-bold mb-4">加入协作</h1>
      <p className="mb-4 text-gray-700">
        {info?.email ? <>你将以 <span className="font-mono font-semibold">{info.email}</span> 身份加入</> : '请输入你的邮箱以完成加入'}
        {info?.role ? <>（<span className="font-semibold">{info.role}</span>）</> : null}
      </p>
      {info && !info.email && (
        <input className="w-full border rounded px-3 py-2 mb-4" placeholder="your@email.com" value={emailInput} onChange={e => setEmailInput(e.target.value)} />
      )}
      {error && <p className="text-red-600 text-sm mb-3">{error}</p>}
      <button onClick={handleJoin} disabled={joining} className="w-full bg-black text-white rounded py-2 disabled:opacity-50">
        {joining ? '加入中…' : '确认加入'}
      </button>
      <p className="text-xs text-gray-400 mt-4">点击确认后将种下 180 天有效期的登录 Cookie，换浏览器需重新获取邀请链接</p>
    </div>
  );
}
