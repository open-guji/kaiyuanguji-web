'use client';
import { useEffect, useState } from 'react';

export default function AdminGuard({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<'loading' | 'ok' | 'denied'>('loading');
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/auth/me', { cache: 'no-store', credentials: 'include' })
      .then(r => r.json().then(j => ({ status: r.status, body: j })))
      .then(({ status, body }) => {
        if (status === 200 && body.success && body.role === 'admin') {
          setEmail(body.email);
          setState('ok');
        } else {
          setState('denied');
        }
      })
      .catch(() => setState('denied'));
  }, []);

  if (state === 'loading') return <div className="p-8 text-center text-gray-500">校验身份…</div>;
  if (state === 'denied') {
    return (
      <div className="max-w-xl mx-auto p-12 text-center">
        <h1 className="text-xl font-semibold mb-2">无权限</h1>
        <p className="text-sm text-gray-600">此页面仅管理员可访问，请联系管理员获取邀请链接后通过 <code>/join?c=...</code> 登录。</p>
        {email && <p className="text-xs text-gray-400 mt-2">当前登录：{email}</p>}
      </div>
    );
  }
  return <>{children}</>;
}
