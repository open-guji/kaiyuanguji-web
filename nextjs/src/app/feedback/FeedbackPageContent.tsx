'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FeedbackItem } from 'book-index-ui';
import { useFeedback } from '@/components/feedback/FeedbackProvider';
import { FEEDBACK_API, FEEDBACK_TYPES, normalizeResourceId } from '@/lib/feedback';
import { useSiteT } from '@/i18n/use-site-t';
import type { SiteMessageKey } from '@/i18n/translate';

const TYPE_LABEL_KEY: Record<string, SiteMessageKey> = {
    ...Object.fromEntries(FEEDBACK_TYPES.map((t) => [t.value, t.labelKey])),
    other: 'feedback.types.other',
};

const STATUS_LABEL_KEY: Record<string, SiteMessageKey> = {
    pending: 'feedback.status.pending',
    in_progress: 'feedback.status.in_progress',
    resolved: 'feedback.status.resolved',
    wontfix: 'feedback.status.wontfix',
    duplicate: 'feedback.status.duplicate',
};

/** 筛选页签：「想参与」后端永远不公开，这里不列 */
const FILTERS: { value: string; labelKey: SiteMessageKey }[] = [
    { value: '', labelKey: 'feedback.page.all' },
    ...FEEDBACK_TYPES.filter((t) => t.value !== 'contact'),
];

function formatDate(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

/**
 * /feedback：公开的反馈列表（N7 样张第 5 组）。
 * 页头唯一的主按钮「写反馈」打开全站统一的弹窗；类型用文字页签筛选；列表不画卡片框，条与条之间一条淡线。
 */
export default function FeedbackPageContent() {
    const { open } = useFeedback();
    const t = useSiteT();
    const [items, setItems] = useState<FeedbackItem[]>([]);
    const [loading, setLoading] = useState(true);
    // 后端给的错误原文，或字典键（加载失败、网络错误：渲染时再取，跟随繁简切换）
    const [error, setError] = useState<{ text?: string; key?: SiteMessageKey } | null>(null);
    const [filter, setFilter] = useState('');

    const load = useCallback(() => {
        setLoading(true);
        return fetch(`${FEEDBACK_API}?limit=50`)
            .then((res) => res.json())
            .then((data) => {
                if (data.success) {
                    setItems(data.items ?? []);
                    setError(null);
                } else {
                    setError(data.error ? { text: data.error } : { key: 'feedback.page.loadFailed' });
                }
            })
            .catch(() => setError({ key: 'feedback.networkError' }))
            .finally(() => setLoading(false));
    }, []);

    useEffect(() => {
        load();
    }, [load]);

    const shown = useMemo(() => (filter ? items.filter((i) => i.type === filter) : items), [items, filter]);

    return (
        <div className="og-paper og-fb-page">
            <div className="og-fb-page-head">
                <div>
                    <h1>{t('feedback.page.title')}</h1>
                    <p>{t('feedback.page.intro')}</p>
                </div>
                <button
                    type="button"
                    className="og-fb-submit"
                    aria-haspopup="dialog"
                    onClick={() => open({ context: null, onSubmitted: () => { setTimeout(load, 500); } })}
                >
                    {t('feedback.page.write')}
                </button>
            </div>

            <div className="og-fb-types og-fb-filter" role="radiogroup" aria-label={t('feedback.page.filterLabel')}>
                {FILTERS.map((f) => (
                    <button key={f.value} type="button" role="radio" aria-checked={filter === f.value} onClick={() => setFilter(f.value)}>
                        {t(f.labelKey)}
                    </button>
                ))}
            </div>

            {error ? (
                <p className="og-fb-page-empty">{error.key ? t(error.key) : error.text}</p>
            ) : loading ? (
                <p className="og-fb-page-empty">{t('feedback.page.loading')}</p>
            ) : shown.length === 0 ? (
                <p className="og-fb-page-empty">{t('feedback.page.empty')}</p>
            ) : (
                <ul className="og-fb-list">
                    {shown.map((item) => {
                        const rid = normalizeResourceId(item.resourceId);
                        return (
                            <li key={item.id}>
                                <div className="og-fb-meta">
                                    <span className="og-fb-meta-type">{TYPE_LABEL_KEY[item.type] ? t(TYPE_LABEL_KEY[item.type]) : item.type}</span>
                                    {rid && <> · <Link href={`/item/${rid}`}>{t('feedback.page.related')}</Link></>}
                                    {formatDate(item.createdAt) && <> · {formatDate(item.createdAt)}</>}
                                    {' · '}
                                    <span className={item.status === 'resolved' ? 'og-fb-meta-ok' : undefined}>
                                        {STATUS_LABEL_KEY[item.status] ? t(STATUS_LABEL_KEY[item.status]) : item.status}
                                    </span>
                                </div>
                                <p className="og-fb-body">{item.content}</p>
                                {item.reply && <p className="og-fb-reply">{t('feedback.page.reply', { reply: item.reply })}</p>}
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}
