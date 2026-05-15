'use client';

import { useEffect, useMemo, useState } from 'react';
import type { IndexStorage } from 'book-index-ui';

/**
 * 详情页顶部版本信息条。展示 production 条目的 semver revision + 修订日期，
 * 提供「复制引用」按钮。
 *
 * 设计：项目进展/古籍索引网站/整体设计/2026-05-版本控制与不可变性.md
 *
 * 数据来源：transport.getItem(id) 返回的原始 detail JSON，从中取 revision /
 * revised_at（draft 条目无此字段，组件渲染为空）。
 */
export interface CitationBarProps {
    id: string;
    transport: IndexStorage;
    redirectedFrom?: string | null;
}

function isoToday(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export default function CitationBar({ id, transport, redirectedFrom }: CitationBarProps) {
    const [meta, setMeta] = useState<{
        revision?: string;
        revised_at?: string;
        title?: string;
    } | null>(null);

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

    const citationText = useMemo(() => {
        if (!meta?.revision) return '';
        const title = meta.title ?? '';
        const rev = meta.revision;
        const date = meta.revised_at ?? isoToday();
        // 学术引用模板：「{title}. 开鉴古籍, ID {id} rev. {rev} ({date}). {url}」
        const url = typeof window !== 'undefined'
            ? `${window.location.origin}/book-index?id=${id}`
            : `https://www.kaiyuanguji.com/book-index?id=${id}`;
        return `${title}. 开鉴古籍, ID ${id} rev. ${rev} (${date}). ${url}`;
    }, [meta, id]);

    const [copied, setCopied] = useState(false);
    const onCopy = async () => {
        if (!citationText) return;
        try {
            await navigator.clipboard.writeText(citationText);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        } catch {
            /* 浏览器拒绝 clipboard API，静默 */
        }
    };

    // draft 条目（无 revision）：仍占 1.75rem 高度但显示"草稿"标签
    // 外层 BookDetailContent 始终扣 1.75rem layoutHeight，保持布局一致
    if (!meta?.revision) {
        return (
            <div
                style={{ height: '1.75rem' }}
                className="bg-amber-50/40 border-b border-stone-200 px-4 flex items-center text-xs text-stone-400"
            >
                <span className="font-mono">draft · {id}</span>
            </div>
        );
    }

    return (
        <div
            style={{ height: '1.75rem' }}
            className="bg-stone-50 border-b border-stone-200 px-4 flex items-center gap-3 text-xs text-stone-600"
        >
            <span className="font-mono">
                rev. <b>{meta.revision}</b>
                {meta.revised_at && <> · {meta.revised_at}</>}
                {' '}<span className="text-stone-400">(ID: {id})</span>
            </span>
            <button
                type="button"
                onClick={onCopy}
                className="ml-auto text-stone-500 hover:text-stone-900 underline underline-offset-2"
                title={citationText}
            >
                {copied ? '已复制' : '复制引用'}
            </button>
            {redirectedFrom && (
                <span className="text-stone-400" title={`原草稿 ID: ${redirectedFrom}`}>
                    ← 已升级
                </span>
            )}
        </div>
    );
}
