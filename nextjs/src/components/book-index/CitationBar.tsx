'use client';

import { useEffect, useState } from 'react';
import type { IndexStorage } from 'book-index-ui';

/**
 * 详情页的版本信息。展示 production 条目的 semver revision + 修订日期。
 *
 * 2026-09 版式重构前它是页面底部一条独立的固定高度横条；现在作为
 * `footerExtra` 并入 BookDetailLayout 的页脚，渲染成一段行内文字，
 * 与页脚其余内容（ID、提交新版本、数据源）排在同一行。
 *
 * 设计：项目进展/古籍索引网站/整体设计/2026-05-版本控制与不可变性.md
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
    } | null>(null);

    useEffect(() => {
        let cancelled = false;
        transport.getItem(id).then((detail) => {
            if (cancelled || !detail) return;
            setMeta({
                revision: (detail as { revision?: string }).revision,
                revised_at: (detail as { revised_at?: string }).revised_at,
            });
        }).catch(() => { /* 静默：detail 加载错误 BookDetailLayout 自己会报 */ });
        return () => { cancelled = true; };
    }, [id, transport]);

    if (!meta?.revision) {
        return <span>draft</span>;
    }

    return (
        <span>
            rev. {meta.revision}
            {meta.revised_at && <> · 最近校訂 {meta.revised_at}</>}
            {redirectedFrom && (
                <span title={`原草稿 ID: ${redirectedFrom}`}> · 已升級</span>
            )}
        </span>
    );
}
