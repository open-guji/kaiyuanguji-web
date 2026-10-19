'use client';

import { useCallback, useEffect, useState } from 'react';
import { useFeedback } from './FeedbackProvider';
import type { FeedbackContext } from '@/lib/feedback';
import { useSiteT } from '@/i18n/use-site-t';
import { canFixChar, spanOfRange, type CharFixCtx, type SpanSel } from '@/lib/charfix';
import SpanFixDialog from '@/components/SpanFixDialog';

interface SelectionReportProps {
    /** 只认这个容器里的选区（阅读器正文所在的外框） */
    containerRef: React.RefObject<HTMLElement | null>;
    /** 本页上下文（书名、卷），「报错」时与选中的文字一起带进弹窗 */
    context: FeedbackContext;
    /**
     * 本章改字上下文（与「改字」入口同一个）：对读章且有文本版本时，「報錯」改开「這段有問題」弹窗，
     * 首末格位与原字自动带上（kind=span）；返回 null 或选区里没有对读字时照旧开通用反馈弹窗
     */
    getCtx?: () => CharFixCtx | null;
    /** 测试注入；默认全局 fetch */
    fetchImpl?: typeof fetch;
}

interface Anchor {
    text: string;
    left: number;
    top: number;
    below: boolean;
}

/** 选区是否落在输入框里（目录检索框等），这类不弹 */
function inField(node: Node | null): boolean {
    const el = node instanceof Element ? node : node?.parentElement;
    return !!el?.closest('input, textarea, [contenteditable="true"]');
}

/**
 * 阅读页选中文字后弹出「复制 ｜ 报错」（N7 样张第 4 组）。
 * 桌面浮在选区上方；触屏（pointer: coarse）放到选区下方，免得和系统的选字菜单打架。
 * 用 fixed 定位，滚动或缩放时先收起，停下来后选区还在就重新量位置再弹。
 */
export default function SelectionReport({ containerRef, context, getCtx, fetchImpl }: SelectionReportProps) {
    const { open } = useFeedback();
    const t = useSiteT();
    const [anchor, setAnchor] = useState<Anchor | null>(null);
    const [copied, setCopied] = useState(false);
    const [spanFix, setSpanFix] = useState<{ ctx: CharFixCtx; span: SpanSel } | null>(null);

    const measure = useCallback(() => {
        const sel = window.getSelection();
        const root = containerRef.current;
        if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !root) {
            setAnchor(null);
            return;
        }
        const range = sel.getRangeAt(0);
        const text = sel.toString().trim();
        if (!text || !root.contains(range.commonAncestorContainer) || inField(range.commonAncestorContainer)) {
            setAnchor(null);
            return;
        }
        const rect = range.getBoundingClientRect();
        const below = window.matchMedia?.('(pointer: coarse)').matches ?? false;
        setAnchor({
            text,
            left: Math.min(Math.max(rect.left + rect.width / 2, 72), window.innerWidth - 72),
            top: below ? rect.bottom + 10 : rect.top - 10,
            below,
        });
        setCopied(false);
    }, [containerRef]);

    useEffect(() => {
        // 拖选过程中 selectionchange 会不停触发，停顿 200ms 再量，免得浮条跟着鼠标闪
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onChange = () => {
            clearTimeout(timer);
            timer = setTimeout(measure, 200);
        };
        const hide = () => {
            setAnchor(null);
            onChange();
        };
        document.addEventListener('selectionchange', onChange);
        window.addEventListener('scroll', hide, true);
        window.addEventListener('resize', hide);
        return () => {
            clearTimeout(timer);
            document.removeEventListener('selectionchange', onChange);
            window.removeEventListener('scroll', hide, true);
            window.removeEventListener('resize', hide);
        };
    }, [measure]);

    if (spanFix) return <SpanFixDialog t={t} ctx={spanFix.ctx} span={spanFix.span} fetchImpl={fetchImpl} onClose={() => setSpanFix(null)} />;
    if (!anchor) return null;

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(anchor.text);
            setCopied(true);
        } catch {
            /* 不给剪贴板权限就算了，系统菜单里还能复制 */
        }
    };

    const report = () => {
        const quote = anchor.text;
        const ctx = getCtx?.() ?? null;
        const sel = window.getSelection();
        const root = containerRef.current;
        const span = ctx && canFixChar(ctx) && sel && sel.rangeCount > 0 && root ? spanOfRange(sel.getRangeAt(0), root, ctx.chars) : null;
        setAnchor(null);
        if (ctx && span) setSpanFix({ ctx, span });
        else open({ context: { ...context, quote }, type: 'bug' });
    };

    return (
        <div
            className={anchor.below ? 'og-fb-pop og-fb-pop--below' : 'og-fb-pop'}
            style={{ left: anchor.left, top: anchor.top }}
            role="toolbar"
            aria-label={t('feedback.selection.toolbar')}
            // 按下时不让浏览器把选区清掉
            onMouseDown={(e) => e.preventDefault()}
        >
            <button type="button" onClick={copy}>{copied ? t('feedback.selection.copied') : t('feedback.selection.copy')}</button>
            <button type="button" onClick={report}>{t('feedback.selection.report')}</button>
        </div>
    );
}
