'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FeedbackItem } from 'book-index-ui';
import { useFeedback } from '@/components/feedback/FeedbackProvider';
import { useSource } from '@/components/common/SourceContext';
import { getTransport } from '@/lib/transport';
import type { DataSource } from '@/lib/constants';
import { FEEDBACK_API, FEEDBACK_TYPES, normalizeResourceId, readMine } from '@/lib/feedback';
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

/** 认领块 → 文案 key（后端 ASSIGNEES，见 feedbackTriage.ts 对表测试） */
const BLOCK_LABEL_KEY: Record<string, SiteMessageKey> = {
    catalog: 'feedback.page.blocks.catalog',
    web: 'feedback.page.blocks.web',
    text: 'feedback.page.blocks.text',
    cv: 'feedback.page.blocks.cv',
    collate: 'feedback.page.blocks.collate',
    layout: 'feedback.page.blocks.layout',
    owner: 'feedback.page.blocks.owner',
};

/** 公开读新增字段（后端只透出 category／assignee／claimedAt，不含 routedIssue） */
type PublicTriage = { assignee?: string; claimedAt?: string };

/** 「已处理」一类：已结的状态。待处理、处理中都算还没处理完，默认列出（用户 10-01 反馈，overview#337 C1） */
const DONE_STATUSES = new Set(['resolved', 'wontfix', 'duplicate']);

/** 筛选页签：「想参与」后端永远不公开，这里不列 */
const FILTERS: { value: string; labelKey: SiteMessageKey }[] = [
    { value: '', labelKey: 'feedback.page.all' },
    ...FEEDBACK_TYPES.filter((t) => t.value !== 'contact'),
];

// 「相关条目」是否还在：同一 id 只查一次（多条反馈常指向同一条目）；查询本身失败按「在」处理，照旧给链接
const entryExists = new Map<string, Promise<boolean>>();
function checkEntry(source: DataSource, id: string): Promise<boolean> {
    const key = `${source}:${id}`;
    let p = entryExists.get(key);
    if (!p) {
        const transport = getTransport(source);
        p = transport.getEntry
            ? transport.getEntry(id).then((e) => !!e, () => true)
            : Promise.resolve(true);
        entryExists.set(key, p);
    }
    return p;
}

/**
 * 「相关条目」：确认条目还在才给链接（overview#359 P2-10：有条反馈指向的条目已删，点进去 404）。
 * 查到之前先出不带链接的文字，查不到写「相关条目已失效」，都不是可点的。
 */
function RelatedLink({ id }: { id: string }) {
    const t = useSiteT();
    const { source } = useSource();
    const [state, setState] = useState<'checking' | 'ok' | 'gone'>('checking');
    useEffect(() => {
        let alive = true;
        setState('checking');
        checkEntry(source, id).then((ok) => { if (alive) setState(ok ? 'ok' : 'gone'); });
        return () => { alive = false; };
    }, [source, id]);
    if (state === 'ok') return <Link href={`/item/${id}`}>{t('feedback.page.related')}</Link>;
    if (state === 'gone') return <span className="og-fb-meta-gone">{t('feedback.page.relatedGone')}</span>;
    return <span>{t('feedback.page.related')}</span>;
}

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
    const t = useSiteT();
    const [items, setItems] = useState<FeedbackItem[]>([]);
    const [loading, setLoading] = useState(true);
    // 后端给的错误原文，或字典键（加载失败、网络错误：渲染时再取，跟随繁简切换）
    const [error, setError] = useState<{ text?: string; key?: SiteMessageKey } | null>(null);
    const [filter, setFilter] = useState('');
    const [showDone, setShowDone] = useState(false);
    // 本机提交过的反馈 id（挂载后再读，避免 SSR 与客户端首屏不一致）
    const [mine, setMine] = useState<Set<string>>(new Set());

    // fresh：刚提交完刷新时绕过边缘缓存（其它 isolate 的缓存最长 30 秒内看不到新条目，「我的」也就标不上）
    const load = useCallback((fresh = false) => {
        setLoading(true);
        return fetch(`${FEEDBACK_API}?limit=50${fresh ? '&fresh=1' : ''}`)
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
    const reloadMine = useCallback(() => setMine(new Set(readMine())), []);
    useEffect(() => { reloadMine(); }, [reloadMine]);

    const shown = useMemo(
        () => items.filter((i) => (!filter || i.type === filter) && (showDone || !DONE_STATUSES.has(i.status))),
        [items, filter, showDone],
    );

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
                    onClick={() => open({ context: null, onSubmitted: () => { reloadMine(); setTimeout(() => load(true), 500); } })}
                >
                    {t('feedback.page.write')}
                </button>
            </div>

            <div className="og-fb-filter">
                <div className="og-fb-types" role="radiogroup" aria-label={t('feedback.page.filterLabel')}>
                    {FILTERS.map((f) => (
                        <button key={f.value} type="button" role="radio" aria-checked={filter === f.value} onClick={() => setFilter(f.value)}>
                            {t(f.labelKey)}
                        </button>
                    ))}
                </div>
                <label className="og-fb-show-done">
                    <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />
                    {t('feedback.page.showDone')}
                </label>
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
                            <li key={item.id} data-mine={mine.has(item.id) ? 'true' : undefined}>
                                <div className="og-fb-meta">
                                    <span className="og-fb-meta-type">{TYPE_LABEL_KEY[item.type] ? t(TYPE_LABEL_KEY[item.type]) : item.type}</span>
                                    {mine.has(item.id) && <> · <span className="og-fb-mine">{t('feedback.page.mine')}</span></>}
                                    {rid && <> · <RelatedLink id={rid} /></>}
                                    {formatDate(item.createdAt) && <> · {formatDate(item.createdAt)}</>}
                                    {' · '}
                                    <span className={item.status === 'resolved' ? 'og-fb-meta-ok' : undefined}>
                                        {STATUS_LABEL_KEY[item.status] ? t(STATUS_LABEL_KEY[item.status]) : item.status}
                                    </span>
                                </div>
                                {(() => {
                                    const a = (item as typeof item & PublicTriage).assignee;
                                    // 已结的不再提「已认领」；未知块名（后端新加了块而前端没跟上）不显示，免得露英文代号
                                    if (!a || DONE_STATUSES.has(item.status) || !BLOCK_LABEL_KEY[a]) return null;
                                    return (
                                        <p className="og-fb-claimed">{t('feedback.page.claimed', { block: t(BLOCK_LABEL_KEY[a]) })}</p>
                                    );
                                })()}
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
