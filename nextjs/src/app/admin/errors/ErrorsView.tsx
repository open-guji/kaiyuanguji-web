'use client';

// 从 /toolkit/errors 搬来（21 第 3 步）。鉴权改走成员 cookie（/api/track-error 双轨），不再用 ?token=。
import { useEffect, useMemo, useState } from 'react';
import { fetchAllPages } from '../fetchAll';

interface ErrorRecord {
  id: string;
  kind: string;
  message: string;
  stack?: string;
  pageUrl?: string;
  source?: string;
  resource?: string;
  status?: number | null; // HTTP 状态码（fetch 失败时）
  state?: string; // 处理状态：open | resolved
  release?: string;
  ua?: string;
  clientIp?: string;
  geo?: string;
  createdAt: string;
}

const KIND_COLORS: Record<string, string> = {
  js: 'bg-red-500',
  unhandledrejection: 'bg-orange-500',
  fetch: 'bg-blue-500',
  resource: 'bg-violet-500',
  react: 'bg-pink-500',
};

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false });
}

export default function ErrorsView() {
  const [items, setItems] = useState<ErrorRecord[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [kindFilter, setKindFilter] = useState('');
  const [hideNotFound, setHideNotFound] = useState(false);
  const [hideResolved, setHideResolved] = useState(true); // 默认隐藏已处理
  const [updatingId, setUpdatingId] = useState('');

  async function load() {
    setLoading(true);
    setError('');
    try {
      const r = await fetchAllPages<ErrorRecord>('/api/track-error', 200);
      r.items.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
      setItems(r.items);
      setTruncated(r.truncated);
    } catch (e: any) {
      setError(e.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, []);

  async function markState(id: string, state: 'open' | 'resolved') {
    setUpdatingId(id);
    try {
      const res = await fetch('/api/track-error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ action: 'update', id, state }),
      });
      const data = await res.json();
      if (data.success) {
        setItems((prev) => prev.map((it) => (it.id === id ? { ...it, state } : it)));
      } else {
        alert(data.error || '操作失败');
      }
    } catch {
      alert('网络错误');
    } finally {
      setUpdatingId('');
    }
  }

  const kinds = useMemo(() => Array.from(new Set(items.map((i) => i.kind))).sort(), [items]);

  const filtered = useMemo(
    () =>
      items.filter((it) => {
        if (kindFilter && it.kind !== kindFilter) return false;
        if (hideNotFound && it.status === 404) return false;
        if (hideResolved && it.state === 'resolved') return false;
        return true;
      }),
    [items, kindFilter, hideNotFound, hideResolved],
  );

  const openCount = useMemo(() => items.filter((i) => i.state !== 'resolved').length, [items]);
  const resolvedCount = items.length - openCount;
  const notFoundCount = useMemo(() => items.filter((i) => i.status === 404).length, [items]);

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-bold">错误日志</h1>
        <button onClick={load} disabled={loading} className="text-xs text-gray-500 hover:text-black">刷新</button>
      </div>
      <p className="text-xs text-gray-500">
        前端上报的 JS 异常 / 资源失败 / fetch 失败。处理完标记「已处理」。
      </p>

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
          <div className="bg-white rounded border p-3 flex flex-wrap items-center gap-4 text-sm">
            <label>
              类型：
              <select value={kindFilter} onChange={(e) => setKindFilter(e.target.value)} className="ml-1 border rounded px-2 py-1 text-sm">
                <option value="">全部</option>
                {kinds.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </label>
            <label className="inline-flex items-center gap-1.5">
              <input type="checkbox" checked={hideResolved} onChange={(e) => setHideResolved(e.target.checked)} />
              隐藏已处理（{resolvedCount}）
            </label>
            <label className="inline-flex items-center gap-1.5">
              <input type="checkbox" checked={hideNotFound} onChange={(e) => setHideNotFound(e.target.checked)} />
              隐藏 404（{notFoundCount}）
            </label>
            <span className="ml-auto text-gray-500">
              未处理 {openCount} · 共 {items.length} · 显示 {filtered.length}
            </span>
          </div>

          {filtered.length === 0 ? (
            <div className="bg-white rounded border p-8 text-center text-sm text-gray-400">无记录</div>
          ) : (
            <div className="space-y-3">
              {filtered.map((it) => {
                const resolved = it.state === 'resolved';
                const busy = updatingId === it.id;
                return (
                  <div key={it.id} className={`bg-white rounded border p-4 text-[13px] ${resolved ? 'opacity-60' : ''}`}>
                    <div className="flex items-center gap-2.5 mb-1.5">
                      <span className={`${KIND_COLORS[it.kind] || 'bg-gray-500'} text-white rounded px-2 text-xs`}>{it.kind}</span>
                      {typeof it.status === 'number' && (
                        <span className={it.status >= 500 ? 'text-red-500' : 'text-gray-500'}>HTTP {it.status}</span>
                      )}
                      {resolved && <span className="bg-emerald-100 text-emerald-800 rounded px-2 text-xs">已处理</span>}
                      <span className="ml-auto text-gray-400">{fmtTime(it.createdAt)}</span>
                      <button
                        onClick={() => markState(it.id, resolved ? 'open' : 'resolved')}
                        disabled={busy}
                        className={`border rounded px-2.5 py-0.5 text-xs ${resolved ? 'text-gray-500' : 'text-emerald-800'} hover:bg-gray-50 disabled:opacity-50`}
                      >
                        {busy ? '…' : resolved ? '重新打开' : '标记已处理'}
                      </button>
                    </div>

                    <div className="font-medium mb-1.5 break-words">{it.message}</div>

                    <div className="text-gray-500 leading-relaxed break-all">
                      {it.resource && <div>资源：{it.resource}</div>}
                      {it.source && <div>位置：{it.source}</div>}
                      {it.pageUrl && <div>页面：{it.pageUrl}</div>}
                      <div>
                        {it.clientIp && <span>IP：{it.clientIp}　</span>}
                        {it.geo && <span>地区：{it.geo}　</span>}
                        {it.release && <span>版本：{it.release}</span>}
                      </div>
                      {it.ua && <div className="text-gray-400">UA：{it.ua}</div>}
                    </div>

                    {it.stack && (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-blue-500">堆栈</summary>
                        <pre className="mt-1.5 p-2.5 bg-gray-50 rounded overflow-auto text-xs whitespace-pre-wrap">{it.stack}</pre>
                      </details>
                    )}
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
