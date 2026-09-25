'use client';

// 反馈处置（21 第 3 步）。读 GET /api/feedback（公开），改状态 / 写回复走 POST action:'update'（成员 cookie）。
import { useEffect, useMemo, useState } from 'react';
import { fetchAllPages } from '../fetchAll';

interface FeedbackRecord {
  id: string;
  type: 'bug' | 'resource' | string;
  content: string;
  pageUrl?: string;
  resourceId?: string;
  createdAt: string;
  updatedAt?: string;
  status: 'pending' | 'resolved' | string;
  reply?: string;
}

const TYPE_LABEL: Record<string, string> = { bug: '错误', resource: '资源' };

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false });
}

export default function FeedbackView() {
  const [items, setItems] = useState<FeedbackRecord[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [hideResolved, setHideResolved] = useState(true);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState('');

  async function load() {
    setLoading(true);
    setError('');
    try {
      const r = await fetchAllPages<FeedbackRecord>('/api/feedback', 100);
      r.items.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
      setItems(r.items);
      setTruncated(r.truncated);
      setDrafts({});
    } catch (e: any) {
      setError(e.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  async function update(id: string, patch: { status?: string; reply?: string }) {
    setSavingId(id);
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action: 'update', id, ...patch }),
      });
      const data = await res.json();
      if (!data.success) { alert(data.error || '操作失败'); return; }
      setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
      if (patch.reply !== undefined) {
        setDrafts((d) => { const n = { ...d }; delete n[id]; return n; });
      }
    } catch {
      alert('网络错误');
    } finally {
      setSavingId('');
    }
  }

  const pendingCount = useMemo(() => items.filter((i) => i.status !== 'resolved').length, [items]);
  const shown = hideResolved ? items.filter((i) => i.status !== 'resolved') : items;

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-bold">反馈</h1>
        <button onClick={load} disabled={loading} className="text-xs text-gray-500 hover:text-black">刷新</button>
      </div>
      <p className="text-xs text-gray-500">读者在各页提交的反馈。<b>回复会在该页的反馈区公开显示。</b></p>

      {error ? (
        <div className="bg-white rounded border p-8 text-center text-sm text-red-600">{error}</div>
      ) : loading ? (
        <div className="bg-white rounded border p-8 text-center text-sm text-gray-500">加载中…</div>
      ) : (
        <>
          {truncated && (
            <div className="rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800">
              记录过多，只取到了前 {items.length} 条（最旧的一批），更新的记录没有显示。
            </div>
          )}
          <div className="bg-white rounded border p-3 flex items-center gap-4 text-sm">
            <label className="inline-flex items-center gap-1.5">
              <input type="checkbox" checked={hideResolved} onChange={(e) => setHideResolved(e.target.checked)} />
              隐藏已解决（{items.length - pendingCount}）
            </label>
            <span className="ml-auto text-gray-500">待处理 {pendingCount} · 共 {items.length}</span>
          </div>

          {shown.length === 0 ? (
            <div className="bg-white rounded border p-8 text-center text-sm text-gray-400">无记录</div>
          ) : (
            <div className="space-y-3">
              {shown.map((it) => {
                const resolved = it.status === 'resolved';
                const busy = savingId === it.id;
                const draft = drafts[it.id];
                const editing = draft !== undefined;
                return (
                  <div key={it.id} className={`bg-white rounded border p-4 text-[13px] ${resolved ? 'opacity-70' : ''}`}>
                    <div className="flex items-center gap-2.5 mb-1.5">
                      <span className={`${it.type === 'bug' ? 'bg-red-500' : 'bg-blue-500'} text-white rounded px-2 text-xs`}>
                        {TYPE_LABEL[it.type] || it.type}
                      </span>
                      {resolved && <span className="bg-emerald-100 text-emerald-800 rounded px-2 text-xs">已解决</span>}
                      <span className="ml-auto text-gray-400">{fmtTime(it.createdAt)}</span>
                      <button
                        onClick={() => update(it.id, { status: resolved ? 'pending' : 'resolved' })}
                        disabled={busy}
                        className={`border rounded px-2.5 py-0.5 text-xs ${resolved ? 'text-gray-500' : 'text-emerald-800'} hover:bg-gray-50 disabled:opacity-50`}
                      >
                        {busy ? '…' : resolved ? '重新打开' : '标记已解决'}
                      </button>
                    </div>

                    <div className="whitespace-pre-wrap break-words mb-1.5">{it.content}</div>
                    <div className="text-gray-500 break-all">
                      {it.pageUrl && <div>页面：<a href={it.pageUrl} target="_blank" rel="noreferrer" className="underline">{it.pageUrl}</a></div>}
                      {it.resourceId && <div>条目：<span className="font-mono">{it.resourceId}</span></div>}
                    </div>

                    <div className="mt-2 border-t pt-2">
                      {editing ? (
                        <div className="space-y-1.5">
                          <textarea
                            className="w-full border rounded p-2 text-sm"
                            rows={3}
                            value={draft}
                            onChange={(e) => setDrafts((d) => ({ ...d, [it.id]: e.target.value }))}
                          />
                          <div className="flex gap-2">
                            <button onClick={() => update(it.id, { reply: draft.trim() })} disabled={busy} className="bg-black text-white rounded px-3 py-1 text-xs disabled:opacity-50">保存回复</button>
                            {!resolved && (
                              <button onClick={() => update(it.id, { reply: draft.trim(), status: 'resolved' })} disabled={busy} className="border rounded px-3 py-1 text-xs text-emerald-800 disabled:opacity-50">保存并标已解决</button>
                            )}
                            <button onClick={() => setDrafts((d) => { const n = { ...d }; delete n[it.id]; return n; })} className="text-xs text-gray-500">取消</button>
                          </div>
                        </div>
                      ) : it.reply ? (
                        <div className="flex gap-2">
                          <div className="flex-1 whitespace-pre-wrap text-gray-700"><span className="text-gray-400">站方回复：</span>{it.reply}</div>
                          <button onClick={() => setDrafts((d) => ({ ...d, [it.id]: it.reply || '' }))} className="text-xs text-gray-500 hover:text-black">修改</button>
                        </div>
                      ) : (
                        <button onClick={() => setDrafts((d) => ({ ...d, [it.id]: '' }))} className="text-xs text-gray-500 hover:text-black">写回复</button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
