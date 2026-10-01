'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FeedbackItem } from 'book-index-ui';
import { useFeedback } from '@/components/feedback/FeedbackProvider';
import { FEEDBACK_API, FEEDBACK_TYPES, normalizeResourceId } from '@/lib/feedback';

const TYPE_LABEL: Record<string, string> = {
    ...Object.fromEntries(FEEDBACK_TYPES.map((t) => [t.value, t.label])),
    other: '其他',
};

const STATUS_LABEL: Record<string, string> = {
    pending: '待处理',
    in_progress: '处理中',
    resolved: '已处理',
    wontfix: '暂不处理',
    duplicate: '重复',
};

/** 「已处理」一类：已结的状态。待处理、处理中都算还没处理完，默认列出（用户 10-01 反馈，overview#337 C1） */
const DONE_STATUSES = new Set(['resolved', 'wontfix', 'duplicate']);

/** 筛选页签：「想参与」后端永远不公开，这里不列 */
const FILTERS = [{ value: '', label: '全部' }, ...FEEDBACK_TYPES.filter((t) => t.value !== 'contact')];

function formatDate(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

/**
 * /feedback：公开的反馈列表（N7 样张第 5 组）。
 * 页头唯一的主按钮「写反馈」打开全站统一的弹窗；类型用文字页签筛选；列表不画卡片框，条与条之间一条淡线。
 * 默认只列没处理完的，页签右边勾「显示已处理」才把已结的也列出来。
 */
export default function FeedbackPageContent() {
    const { open } = useFeedback();
    const [items, setItems] = useState<FeedbackItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [filter, setFilter] = useState('');
    const [showDone, setShowDone] = useState(false);

    const load = useCallback(() => {
        setLoading(true);
        return fetch(`${FEEDBACK_API}?limit=50`)
            .then((res) => res.json())
            .then((data) => {
                if (data.success) {
                    setItems(data.items ?? []);
                    setError('');
                } else {
                    setError(data.error || '加载失败');
                }
            })
            .catch(() => setError('网络错误，请稍后重试'))
            .finally(() => setLoading(false));
    }, []);

    useEffect(() => {
        load();
    }, [load]);

    const shown = useMemo(
        () => items.filter((i) => (!filter || i.type === filter) && (showDone || !DONE_STATUSES.has(i.status))),
        [items, filter, showDone],
    );

    return (
        <div className="og-paper og-fb-page">
            <div className="og-fb-page-head">
                <div>
                    <h1>用户反馈</h1>
                    <p>大家提的问题和处理进展</p>
                </div>
                <button
                    type="button"
                    className="og-fb-submit"
                    aria-haspopup="dialog"
                    onClick={() => open({ context: null, onSubmitted: () => { setTimeout(load, 500); } })}
                >
                    写反馈
                </button>
            </div>

            <div className="og-fb-filter">
                <div className="og-fb-types" role="radiogroup" aria-label="按类型筛选">
                    {FILTERS.map((f) => (
                        <button key={f.value} type="button" role="radio" aria-checked={filter === f.value} onClick={() => setFilter(f.value)}>
                            {f.label}
                        </button>
                    ))}
                </div>
                <label className="og-fb-show-done">
                    <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />
                    显示已处理
                </label>
            </div>

            {error ? (
                <p className="og-fb-page-empty">{error}</p>
            ) : loading ? (
                <p className="og-fb-page-empty">加载中…</p>
            ) : shown.length === 0 ? (
                <p className="og-fb-page-empty">暂无反馈</p>
            ) : (
                <ul className="og-fb-list">
                    {shown.map((item) => {
                        const rid = normalizeResourceId(item.resourceId);
                        return (
                            <li key={item.id}>
                                <div className="og-fb-meta">
                                    <span className="og-fb-meta-type">{TYPE_LABEL[item.type] ?? item.type}</span>
                                    {rid && <> · <Link href={`/item/${rid}`}>相关条目</Link></>}
                                    {formatDate(item.createdAt) && <> · {formatDate(item.createdAt)}</>}
                                    {' · '}
                                    <span className={item.status === 'resolved' ? 'og-fb-meta-ok' : undefined}>
                                        {STATUS_LABEL[item.status] ?? item.status}
                                    </span>
                                </div>
                                <p className="og-fb-body">{item.content}</p>
                                {item.reply && <p className="og-fb-reply">站方回复：{item.reply}</p>}
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}
