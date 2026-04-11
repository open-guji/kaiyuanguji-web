'use client';

import { useState, useEffect, useCallback } from 'react';
import { FeedbackList, FeedbackForm } from 'book-index-ui';
import type { FeedbackItem } from 'book-index-ui';

interface FeedbackTabProps {
    resourceId: string;
}

const FEEDBACK_API = typeof window !== 'undefined' && window.location.hostname === 'localhost'
    ? 'https://www.kaiyuanguji.com/api/feedback'
    : '/api/feedback';

export default function FeedbackTab({ resourceId }: FeedbackTabProps) {
    const [items, setItems] = useState<FeedbackItem[]>([]);
    const [loading, setLoading] = useState(true);

    const loadFeedback = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch(`${FEEDBACK_API}?resourceId=${encodeURIComponent(resourceId)}`);
            const data = await res.json();
            if (data.success) {
                setItems(data.items);
            }
        } catch {
            // ignore
        } finally {
            setLoading(false);
        }
    }, [resourceId]);

    useEffect(() => {
        loadFeedback();
    }, [loadFeedback]);

    const handleSubmit = async (data: { type: string; content: string }) => {
        const res = await fetch(FEEDBACK_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ...data,
                pageUrl: window.location.href,
                resourceId,
            }),
        });
        if (!res.ok) {
            const err = await res.json().catch(() => null);
            throw new Error(err?.error || '提交失败');
        }
        setTimeout(() => loadFeedback(), 500);
    };

    return (
        <div>
            <FeedbackList items={items} loading={loading} />
            <div style={{ marginTop: '24px' }}>
                <FeedbackForm onSubmit={handleSubmit} />
            </div>
        </div>
    );
}
