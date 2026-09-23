'use client';
import { useEffect, useState } from 'react';

type Invite = { hash: string; email: string | null; role: string; expires: number; createdBy?: string; createdAt: number };

export default function InvitesPage() {
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('reviewer');
  const [inviteLink, setInviteLink] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch('/api/auth/invites', { credentials: 'include', cache: 'no-store' });
      const j = await res.json();
      if (!j.success) throw new Error(j.error);
      setInvites(j.invites);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  async function handleInvite() {
    setError(null); setInviteLink(null);
    if (!inviteEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inviteEmail)) { setError('请填写正确邮箱'); return; }
    const res = await fetch('/api/auth/invite', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ email: inviteEmail.trim().toLowerCase(), role: inviteRole }) });
    const j = await res.json(); if (!j.success) { setError(j.error); return; }
    setInviteLink(j.link); setInviteEmail(''); load();
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">邀请</h1>
      <p className="text-xs text-gray-500">仅显示未使用且未过期的邀请（7 天有效，一次性）</p>
      <div className="bg-white rounded border p-4 space-y-3">
        <h2 className="text-sm font-semibold">发新邀请</h2>
        <div className="flex gap-2">
          <input className="flex-1 border rounded px-2 py-1 text-sm" placeholder="someone@example.com" value={inviteEmail} onChange={e => setInviteEmail(e.target.value)} />
          <select className="border rounded px-2 py-1 text-sm" value={inviteRole} onChange={e => setInviteRole(e.target.value)}>
            <option value="reviewer">reviewer</option><option value="editor">editor</option><option value="admin">admin</option>
          </select>
          <button onClick={handleInvite} className="bg-black text-white rounded px-3 py-1 text-sm">生成链接</button>
        </div>
        {inviteLink && <p className="text-sm break-all bg-gray-50 p-2 rounded">链接：<a href={inviteLink} className="underline">{inviteLink}</a></p>}
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>
      <div className="bg-white rounded border p-4">
        <div className="flex justify-between mb-2"><span className="text-sm font-semibold">待使用</span><button onClick={load} className="text-xs text-gray-500 hover:text-black">刷新</button></div>
        {loading ? <p className="text-sm text-gray-500">加载中…</p> : error ? <p className="text-sm text-red-600">{error}</p> : invites.length === 0 ? <p className="text-sm text-gray-400">暂无</p> : (
          <table className="w-full text-sm">
            <thead><tr className="text-xs text-gray-500 text-left"><th className="pb-1">邮箱</th><th>角色</th><th>过期</th></tr></thead>
            <tbody>
              {invites.map(it => (
                <tr key={it.hash} className="border-t">
                  <td className="py-1 font-mono text-xs">{it.email ?? '（待填）'}</td>
                  <td className="text-xs">{it.role}</td>
                  <td className="text-xs text-gray-500">{new Date(it.expires * 1000).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
