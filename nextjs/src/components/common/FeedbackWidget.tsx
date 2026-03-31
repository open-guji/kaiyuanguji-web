'use client';

import { FeedbackButton } from 'book-index-ui';

export default function FeedbackWidget() {
  const handleSubmit = async (data: { type: string; content: string }) => {
    const res = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...data,
        pageUrl: window.location.href,
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.error || '提交失败，请稍后重试');
    }
  };

  return <FeedbackButton onSubmit={handleSubmit} />;
}
