'use client';

import { useEffect, useState } from 'react';
import { FeedbackList } from 'book-index-ui';
import type { FeedbackItem } from 'book-index-ui';

export default function FeedbackPageContent() {
  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/feedback?limit=50')
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          setItems(data.items);
        } else {
          setError(data.error || '加载失败');
        }
      })
      .catch(() => setError('网络错误，请稍后重试'))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div style={{ maxWidth: 800, margin: '0 auto', padding: '40px 20px' }}>
      <h1 style={{ fontSize: '24px', fontWeight: 600, marginBottom: '8px' }}>
        用户反馈
      </h1>
      <p style={{ color: '#6b7280', fontSize: '14px', marginBottom: '32px' }}>
        查看社区反馈与处理进展
      </p>

      {error ? (
        <div style={{ textAlign: 'center', padding: '40px 0', color: '#f44336' }}>
          {error}
        </div>
      ) : (
        <FeedbackList items={items} loading={loading} />
      )}
    </div>
  );
}
