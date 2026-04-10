'use client';

import { FeedbackButton } from 'book-index-ui';

export default function FeedbackWidget() {
  const handleSubmit = async (data: { type: string; content: string }) => {
    // 从 URL 提取当前资源 ID（/book-index?id=XXX 或 /GY4xxx 路径）
    const params = new URLSearchParams(window.location.search);
    const resourceId = params.get('id') || window.location.pathname.replace(/^\//, '').split('/')[0] || '';

    const res = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...data,
        pageUrl: window.location.href,
        resourceId: resourceId.match(/^[A-Za-z0-9]{11}$/) ? resourceId : '',
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.error || '提交失败，请稍后重试');
    }
  };

  return <FeedbackButton onSubmit={handleSubmit} feedbackListUrl="/book-index?tab=feedback" />;
}
