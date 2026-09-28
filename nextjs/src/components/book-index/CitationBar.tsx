'use client';

import { useEffect, useState } from 'react';
import type { IndexStorage } from 'book-index-ui';
import { useFeedback, useFeedbackPageContext } from '@/components/feedback/FeedbackProvider';
import { itemLabel } from '@/lib/feedback';

/**
 * 详情页的版本信息。展示 production 条目的 semver revision + 修订日期。
 *
 * 2026-09 版式重构前它是页面底部一条独立的固定高度横条；现在作为
 * `footerExtra` 并入 BookDetailLayout 的页脚，渲染成一段行内文字，
 * 与页脚其余内容（ID、提交新版本、数据源）排在同一行。
 *
 * 设计：项目进展/古籍索引网站/整体设计/2026-05-版本控制与不可变性.md
 *
 * N7：末尾带一个「这条有误？」，打开反馈弹窗并带上本条目（书名 · 类型 · id）；
 * 同时把本条目登记为页面上下文，从导航栏点「反馈」也会带上。
 * 样张原想放在提要卡底部，但提要卡在 book-index-ui 里、没有宿主插槽，先放在这里。
 */
export interface CitationBarProps {
    id: string;
    transport: IndexStorage;
    redirectedFrom?: string | null;
}

export default function CitationBar({ id, transport, redirectedFrom }: CitationBarProps) {
    const [meta, setMeta] = useState<{
        revision?: string;
        revised_at?: string;
        title?: string;
    } | null>(null);
    const { open: openFeedback } = useFeedback();
    const feedbackContext = { resourceId: id, label: itemLabel(id, meta?.title) };
    useFeedbackPageContext(feedbackContext);

    useEffect(() => {
        let cancelled = false;
        transport.getItem(id).then((detail) => {
            if (cancelled || !detail) return;
            setMeta({
                revision: (detail as { revision?: string }).revision,
                revised_at: (detail as { revised_at?: string }).revised_at,
                title: (detail as { title?: string }).title,
            });
        }).catch(() => { /* 静默：detail 加载错误 BookDetailLayout 自己会报 */ });
        return () => { cancelled = true; };
    }, [id, transport]);

    const report = (
        <>
            {' · '}
            <button type="button" className="og-fb-inline" onClick={() => openFeedback({ context: feedbackContext, type: 'bug' })}>
                这条有误？
            </button>
        </>
    );

    if (!meta?.revision) {
        return <span>draft{report}</span>;
    }

    return (
        <span>
            rev. {meta.revision}
            {meta.revised_at && <> · 最近校訂 {meta.revised_at}</>}
            {redirectedFrom && (
                <span title={`原草稿 ID: ${redirectedFrom}`}> · 已升級</span>
            )}
            {report}
        </span>
    );
}
