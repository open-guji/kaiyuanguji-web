'use client';
import { useEffect, useState } from 'react';

type Member = { email: string; role: string; joinedAt: number; invitedBy?: string; updatedAt?: number };

export default function MembersPage() {
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('reviewer');
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [pendingRoles, setPendingRoles] = useState<Record<string, string>>({});
  const [updating, setUpdating] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/members', { credentials: 'include', cache: 'no-store' });
      const j = await res.json();
      if (!j.success) throw new Error(j.error || '加载失败');
      setMembers(j.members);
      setPendingRoles({});
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  async function handleInvite() {
    setError(null);
    setInviteLink(null);
    if (!inviteEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inviteEmail)) { setError('请填写正确邮箱'); return; }
    const res = await fetch('/api/auth/invite', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ email: inviteEmail.trim().toLowerCase(), role: inviteRole }),
    });
    const j = await res.json();
    if (!j.success) { setError(j.error); return; }
    setInviteLink(j.link);
    setInviteEmail('');
    load();
  }
  async function handleConfirmRole(email: string) {
    const role = pendingRoles[email];
    if (!role) return;
    if (!confirm(`确定将 ${email} 的角色改为 ${role}？`)) return;
    setUpdating(email);
    setError(null);
    try {
      const res = await fetch('/api/auth/revoke', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ email, role }),
      });
      const j = await res.json();
      if (!j.success) throw new Error(j.error);
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setUpdating(null); }
  }
  async function handleDelete(email: string) {
    if (!confirm(`确定删除 ${email}？其登录将立即失效`)) return;
    const res = await fetch('/api/auth/revoke', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ email }),
    });
    const j = await res.json();
    if (!j.success) setError(j.error); else load();
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">成员</h1>

      <div className="bg-white rounded border p-4 space-y-3">
        <h2 className="text-sm font-semibold">发邀请</h2>
        <div className="flex gap-2">
          <input className="flex-1 border rounded px-2 py-1 text-sm" placeholder="someone@example.com" value={inviteEmail} onChange={e => setInviteEmail(e.target.value)} />
          <select className="border rounded px-2 py-1 text-sm" value={inviteRole} onChange={e => setInviteRole(e.target.value)}>
            <option value="reviewer">reviewer</option>
            <option value="editor">editor</option>
            <option value="admin">admin</option>
          </select>
          <button onClick={handleInvite} className="bg-black text-white rounded px-3 py-1 text-sm">生成链接</button>
        </div>
        {inviteLink && <p className="text-sm break-all bg-gray-50 p-2 rounded">链接：<a href={inviteLink} className="underline">{inviteLink}</a>（手工发给对方）</p>}
        {error && <p className="text-sm text-red-600">{error}</p>}
      </div>

      <div className="bg-white rounded border p-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold">成员列表</h2>
          <button onClick={load} className="text-xs text-gray-500 hover:text-black">刷新</button>
        </div>
        {loading ? <p className="text-sm text-gray-500">加载中…</p> : (
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-gray-500"><th className="pb-1">邮箱</th><th>角色</th><th>加入时间</th><th></th></tr></thead>
            <tbody>
              {members.map(m => {
                const pending = pendingRoles[m.email] ?? m.role;
                const changed = pending !== m.role;
                return (
                  <tr key={m.email} className="border-t">
                    <td className="py-1 font-mono text-xs">{m.email}</td>
                    <td>
                      <div className="flex items-center gap-1">
                        <select value={pending} onChange={e => setPendingRoles(prev => ({ ...prev, [m.email]: e.target.value }))} className="border rounded px-1 py-0.5 text-xs">
                          <option value="reviewer">reviewer</option><option value="editor">editor</option><option value="admin">admin</option>
                        </select>
                        {changed && (
                          <button onClick={() => handleConfirmRole(m.email)} disabled={updating === m.email} className="text-xs bg-black text-white rounded px-2 py-0.5 disabled:opacity-50">确定</button>
                        )}
                      </div>
                    </td>
                    <td className="text-xs text-gray-500">{m.joinedAt ? new Date(m.joinedAt * 1000).toLocaleDateString() : '-'}</td>
                    <td className="text-right"><button onClick={() => handleDelete(m.email)} className="text-xs text-red-600 hover:underline">删除</button></td>
                  </tr>
                );
              })}
              {members.length === 0 && <tr><td colSpan={4} className="py-4 text-center text-sm text-gray-400">暂无成员</td></tr>}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
