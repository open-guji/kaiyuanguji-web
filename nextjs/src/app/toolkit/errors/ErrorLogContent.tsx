'use client';

import { useEffect, useMemo, useState } from 'react';

interface ErrorRecord {
  id: string;
  kind: string;
  message: string;
  stack?: string;
  pageUrl?: string;
  source?: string;
  resource?: string;
  status?: number | null;
  release?: string;
  ua?: string;
  clientIp?: string;
  geo?: string;
  createdAt: string;
}

const KIND_COLORS: Record<string, string> = {
  js: '#ef4444',
  unhandledrejection: '#f97316',
  fetch: '#3b82f6',
  resource: '#8b5cf6',
  react: '#ec4899',
};

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false });
}

export default function ErrorLogContent() {
  const [items, setItems] = useState<ErrorRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [kindFilter, setKindFilter] = useState('');
  const [hideNotFound, setHideNotFound] = useState(true); // 默认隐藏 404 噪音（多为坏链）

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get('token') || '';
    if (!token) {
      setError('缺少 token。请用 /toolkit/errors?token=<ERROR_VIEW_TOKEN> 访问。');
      setLoading(false);
      return;
    }
    fetch(`/api/track-error?token=${encodeURIComponent(token)}&limit=200`)
      .then((res) => res.json())
      .then((data) => {
        if (data.success) setItems(data.items || []);
        else setError(data.error || '加载失败');
      })
      .catch(() => setError('网络错误，请稍后重试'))
      .finally(() => setLoading(false));
  }, []);

  const kinds = useMemo(
    () => Array.from(new Set(items.map((i) => i.kind))).sort(),
    [items],
  );

  const filtered = useMemo(
    () =>
      items.filter((it) => {
        if (kindFilter && it.kind !== kindFilter) return false;
        if (hideNotFound && it.status === 404) return false;
        return true;
      }),
    [items, kindFilter, hideNotFound],
  );

  const notFoundCount = useMemo(
    () => items.filter((i) => i.status === 404).length,
    [items],
  );

  return (
    <div style={{ maxWidth: 960, margin: '0 auto', padding: '40px 20px' }}>
      <h1 style={{ fontSize: '24px', fontWeight: 600, marginBottom: '8px' }}>错误日志</h1>
      <p style={{ color: '#6b7280', fontSize: '14px', marginBottom: '24px' }}>
        前端上报的 JS 异常 / 资源失败 / fetch 失败（保留约 30 天）。
      </p>

      {error ? (
        <div style={{ textAlign: 'center', padding: '40px 0', color: '#f44336' }}>{error}</div>
      ) : loading ? (
        <div style={{ textAlign: 'center', padding: '40px 0', color: '#6b7280' }}>加载中…</div>
      ) : (
        <>
          <div
            style={{
              display: 'flex',
              gap: '16px',
              alignItems: 'center',
              flexWrap: 'wrap',
              marginBottom: '20px',
              fontSize: '14px',
            }}
          >
            <label>
              类型：
              <select
                value={kindFilter}
                onChange={(e) => setKindFilter(e.target.value)}
                style={{ marginLeft: '6px', padding: '4px 8px' }}
              >
                <option value="">全部</option>
                {kinds.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <input
                type="checkbox"
                checked={hideNotFound}
                onChange={(e) => setHideNotFound(e.target.checked)}
              />
              隐藏 404（{notFoundCount} 条，多为坏链）
            </label>
            <span style={{ color: '#6b7280', marginLeft: 'auto' }}>
              共 {items.length} 条，显示 {filtered.length} 条
            </span>
          </div>

          {filtered.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 0', color: '#6b7280' }}>无记录</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {filtered.map((it) => (
                <div
                  key={it.id}
                  style={{
                    border: '1px solid #e5e7eb',
                    borderRadius: '8px',
                    padding: '14px 16px',
                    fontSize: '13px',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '6px' }}>
                    <span
                      style={{
                        background: KIND_COLORS[it.kind] || '#6b7280',
                        color: '#fff',
                        borderRadius: '4px',
                        padding: '1px 8px',
                        fontSize: '12px',
                      }}
                    >
                      {it.kind}
                    </span>
                    {typeof it.status === 'number' && (
                      <span style={{ color: it.status >= 500 ? '#ef4444' : '#6b7280' }}>
                        HTTP {it.status}
                      </span>
                    )}
                    <span style={{ color: '#9ca3af', marginLeft: 'auto' }}>{fmtTime(it.createdAt)}</span>
                  </div>

                  <div style={{ fontWeight: 500, marginBottom: '6px', wordBreak: 'break-word' }}>
                    {it.message}
                  </div>

                  <div style={{ color: '#6b7280', lineHeight: 1.7, wordBreak: 'break-all' }}>
                    {it.resource && <div>资源：{it.resource}</div>}
                    {it.source && <div>位置：{it.source}</div>}
                    {it.pageUrl && <div>页面：{it.pageUrl}</div>}
                    <div>
                      {it.clientIp && <span>IP：{it.clientIp}　</span>}
                      {it.geo && <span>地区：{it.geo}　</span>}
                      {it.release && <span>版本：{it.release}</span>}
                    </div>
                    {it.ua && <div style={{ color: '#9ca3af' }}>UA：{it.ua}</div>}
                  </div>

                  {it.stack && (
                    <details style={{ marginTop: '8px' }}>
                      <summary style={{ cursor: 'pointer', color: '#3b82f6' }}>堆栈</summary>
                      <pre
                        style={{
                          marginTop: '6px',
                          padding: '10px',
                          background: '#f9fafb',
                          borderRadius: '6px',
                          overflow: 'auto',
                          fontSize: '12px',
                          whiteSpace: 'pre-wrap',
                        }}
                      >
                        {it.stack}
                      </pre>
                    </details>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
