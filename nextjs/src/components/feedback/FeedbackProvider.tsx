'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import FeedbackDialog from './FeedbackDialog';
import type { FeedbackContext, FeedbackKind } from '@/lib/feedback';

export interface OpenFeedbackOptions {
    /** 不传就用当前页登记的上下文（条目页、阅读页）；传 null 表示不带任何上下文 */
    context?: FeedbackContext | null;
    /** 默认：有上下文时「内容有误」，没有时「功能建议」 */
    type?: FeedbackKind;
    /** 提交成功后回调（/feedback 页用来刷新列表） */
    onSubmitted?: () => void;
}

interface FeedbackApi {
    open: (opts?: OpenFeedbackOptions) => void;
    setPageContext: (ctx: FeedbackContext | null) => void;
}

// 不在 Provider 里时（单测里单独渲染某个组件）什么也不做，不抛错
const FeedbackCtx = createContext<FeedbackApi>({ open: () => {}, setPageContext: () => {} });

interface DialogState extends OpenFeedbackOptions {
    context: FeedbackContext | null;
    type: FeedbackKind;
    seq: number;
}

/**
 * 全站唯一的反馈弹窗（N7）。挂在 LayoutWrapper 里，导航栏「反馈」、条目页「这条有误？」、
 * 阅读页选字「报错」、/feedback 页「写反馈」都调同一个 open()。
 */
export function FeedbackProvider({ children }: { children: React.ReactNode }) {
    const [dialog, setDialog] = useState<DialogState | null>(null);
    const pageContext = useRef<FeedbackContext | null>(null);
    const seq = useRef(0);

    const open = useCallback((opts: OpenFeedbackOptions = {}) => {
        const context = opts.context !== undefined ? opts.context : pageContext.current;
        seq.current += 1;
        setDialog({
            ...opts,
            context,
            type: opts.type ?? (context ? 'bug' : 'suggestion'),
            seq: seq.current,
        });
    }, []);

    const setPageContext = useCallback((ctx: FeedbackContext | null) => {
        pageContext.current = ctx;
    }, []);

    const api = useMemo(() => ({ open, setPageContext }), [open, setPageContext]);

    return (
        <FeedbackCtx.Provider value={api}>
            {children}
            {dialog && (
                <FeedbackDialog
                    key={dialog.seq}
                    initialContext={dialog.context}
                    initialType={dialog.type}
                    onSubmitted={dialog.onSubmitted}
                    onClose={() => setDialog(null)}
                />
            )}
        </FeedbackCtx.Provider>
    );
}

export function useFeedback(): FeedbackApi {
    return useContext(FeedbackCtx);
}

/**
 * 登记当前页的反馈上下文：此后从导航栏点「反馈」也会带上它。页面卸载时清掉。
 * 传 null 表示本页没有可带的上下文。
 */
export function useFeedbackPageContext(ctx: FeedbackContext | null): void {
    const { setPageContext } = useFeedback();
    const resourceId = ctx?.resourceId;
    const label = ctx?.label;
    useEffect(() => {
        setPageContext(resourceId || label ? { resourceId, label } : null);
        return () => setPageContext(null);
    }, [setPageContext, resourceId, label]);
}
