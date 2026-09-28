'use client';

import { useCallback, useEffect, useState } from 'react';
import { useFeedback } from './FeedbackProvider';
import type { FeedbackContext } from '@/lib/feedback';

interface SelectionReportProps {
    /** 只认这个容器里的选区（阅读器正文所在的外框） */
    containerRef: React.RefObject<HTMLElement | null>;
    /** 本页上下文（书名、卷），「报错」时与选中的文字一起带进弹窗 */
    context: FeedbackContext;
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
export default function SelectionReport({ containerRef, context }: SelectionReportProps) {
    const { open } = useFeedback();
    const [anchor, setAnchor] = useState<Anchor | null>(null);
    const [copied, setCopied] = useState(false);

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
        setAnchor(null);
        open({ context: { ...context, quote }, type: 'bug' });
    };

    return (
        <div
            className={anchor.below ? 'og-fb-pop og-fb-pop--below' : 'og-fb-pop'}
            style={{ left: anchor.left, top: anchor.top }}
            role="toolbar"
            aria-label="选中文字"
            // 按下时不让浏览器把选区清掉
            onMouseDown={(e) => e.preventDefault()}
        >
            <button type="button" onClick={copy}>{copied ? '已复制' : '复制'}</button>
            <button type="button" onClick={report}>报错</button>
        </div>
    );
}
