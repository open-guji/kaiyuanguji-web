'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';

const ERRORS: Record<string, string> = {
  expired: '登录链接已失效或已使用，请重新获取。',
  blocked: '这个邮箱暂时不能登录，请联系管理员。',
  config: '登录服务暂未配置好，请稍后再试。',
  server: '登录服务暂时出错，请稍后再试。',
};

export default function RegisterClient() {
  const sp = useSearchParams();
  const err = sp.get('error');
  const next = sp.get('next');
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'fail'>('idle');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState('sending');
    try {
      const cb = `/api/ba-session${next && next.startsWith('/') && !next.startsWith('//') ? `?next=${encodeURIComponent(next)}` : ''}`;
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

  return (
    <div className="max-w-md mx-auto p-8">
      <h1 className="text-2xl font-bold mb-4">登录／注册</h1>
      {err && ERRORS[err] && <p className="mb-4 text-red-600">{ERRORS[err]}</p>}
      {state === 'sent' ? (
        <p className="text-gray-700">如果这个邮箱可以登录，登录链接已发到你的邮箱（10 分钟内有效）。没收到请看垃圾邮件箱。</p>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <p className="text-gray-700">输入邮箱，我们发一封登录链接给你，无需密码。</p>
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" className="w-full border rounded px-3 py-2" />
          <button type="submit" disabled={state === 'sending'} className="px-4 py-2 rounded bg-gray-900 text-white disabled:opacity-50">
            {state === 'sending' ? '发送中…' : '发送登录链接'}
          </button>
          {state === 'fail' && <p className="text-red-600">发送失败，请稍后再试。</p>}
        </form>
      )}
    </div>
  );
}
