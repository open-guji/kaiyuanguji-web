'use client';

import { useState, useEffect, useCallback } from 'react';
import { FeedbackList, FeedbackDialog } from 'book-index-ui';
import type { FeedbackItem } from 'book-index-ui';

interface FeedbackTabProps {
    resourceId: string;
}

export default function FeedbackTab({ resourceId }: FeedbackTabProps) {
    const [items, setItems] = useState<FeedbackItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [dialogOpen, setDialogOpen] = useState(false);

    const loadFeedback = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch(`/api/feedback?resourceId=${encodeURIComponent(resourceId)}`);
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
        const res = await fetch('/api/feedback', {
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
        // 提交成功后刷新列表
        setTimeout(() => loadFeedback(), 500);
    };

    return (
        <div>
            <FeedbackList items={items} loading={loading} />

            <div style={{ marginTop: '24px' }}>
                <button
                    onClick={() => setDialogOpen(true)}
                    className="px-4 py-2 text-sm rounded-md bg-vermilion text-white hover:opacity-90 transition-opacity"
                >
                    提交反馈
                </button>
            </div>

            <FeedbackDialog
                isOpen={dialogOpen}
                onClose={() => setDialogOpen(false)}
                onSubmit={handleSubmit}
            />
        </div>
    );
}
