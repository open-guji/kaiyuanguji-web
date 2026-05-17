'use client';

import { useEffect, useState } from 'react';
import type { IndexStorage } from 'book-index-ui';

/**
 * 详情页底部版本信息条。展示 production 条目的 semver revision + 修订日期。
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
        return (
            <div
                style={{ height: '1.5rem' }}
                className="border-t border-stone-200 px-4 flex items-center text-[11px] text-stone-500 font-mono"
            >
                draft · {id}
            </div>
        );
    }

    return (
        <div
            style={{ height: '1.5rem' }}
            className="border-t border-stone-200 px-4 flex items-center gap-2 text-[11px] text-stone-600 font-mono"
        >
            <span>
                rev. {meta.revision}
                {meta.revised_at && <> · {meta.revised_at}</>}
                {' · '}{id}
            </span>
            {redirectedFrom && (
                <span className="ml-auto text-stone-400" title={`原草稿 ID: ${redirectedFrom}`}>
                    ← 已升级
                </span>
            )}
        </div>
    );
}
