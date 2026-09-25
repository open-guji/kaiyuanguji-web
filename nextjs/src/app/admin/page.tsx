'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { fetchAllPages } from './fetchAll';

type Count = number | 'err' | null;

async function countInvites(): Promise<number> {
  const res = await fetch('/api/auth/invites', { credentials: 'include', cache: 'no-store' });
  const j = await res.json();
  if (!j.success) throw new Error(j.error);
  return (j.invites || []).length;
}

export default function AdminOverviewPage() {
  const [errors, setErrors] = useState<Count>(null);
  const [feedback, setFeedback] = useState<Count>(null);
  const [invites, setInvites] = useState<Count>(null);

  useEffect(() => {
    fetchAllPages<{ state?: string }>('/api/track-error', 200)
      .then((r) => setErrors(r.items.filter((i) => i.state !== 'resolved').length))
      .catch(() => setErrors('err'));
    fetchAllPages<{ status?: string; test?: boolean }>('/api/feedback', 100)
      .then((r) => setFeedback(r.items.filter((i) => !i.test && i.status !== 'resolved').length))
      .catch(() => setFeedback('err'));
    countInvites().then(setInvites).catch(() => setInvites('err'));
  }, []);

  const cards: { label: string; value: Count; href: string }[] = [
    { label: '待处理错误', value: errors, href: '/admin/errors' },
    { label: '待处理反馈', value: feedback, href: '/admin/feedback' },
    { label: '待使用邀请', value: invites, href: '/admin/invites' },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">总览</h1>
      <div className="grid grid-cols-3 gap-4">
        {cards.map((c) => (
          <Link key={c.href} href={c.href} className="bg-white rounded border p-4 hover:border-gray-400">
            <div className="text-xs text-gray-500">{c.label}</div>
            <div className="text-2xl font-mono mt-1">
              {c.value === null ? '…' : c.value === 'err' ? <span className="text-red-500 text-base">取数失败</span> : c.value}
            </div>
          </Link>
        ))}
      </div>
      <div className="bg-white rounded border p-4 text-sm text-gray-600">
        <p>
          探活结果目前只在 GitHub 上看：
          <a className="underline" href="https://github.com/open-guji/kaiyuanguji-web/actions/workflows/health-check.yml" target="_blank" rel="noreferrer">health-check 运行记录</a>。
        </p>
      </div>
    </div>
  );
}
