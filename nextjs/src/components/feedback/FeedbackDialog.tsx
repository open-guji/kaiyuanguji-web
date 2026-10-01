'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import {
    CONTACT_MAX,
    FEEDBACK_TYPES,
    buildFeedbackBody,
    clampQuote,
    contentBudget,
    submitFeedback,
    type FeedbackContext,
    type FeedbackKind,
} from '@/lib/feedback';
import { useSiteT } from '@/i18n/use-site-t';

interface FeedbackDialogProps {
    initialContext: FeedbackContext | null;
    initialType: FeedbackKind;
    onClose: () => void;
    onSubmitted?: () => void;
    /** 测试注入；默认全局 fetch */
    fetchImpl?: typeof fetch;
}

const FOCUSABLE = 'a[href], button:not([disabled]), textarea, input, [tabindex]:not([tabindex="-1"])';

/**
 * 反馈弹窗（N7 样张第 2 组）：桌面居中，手机（<768px）贴底成抽屉，样式见 globals.css 的 .og-fb-*。
 * 类型是一排文字页签，输入框靠底色区分，整个弹窗只有「提交」一个按钮。
 *
 * 无障碍：模态对话框，打开时焦点落在正文输入框，Tab 困在里面，Esc 或点遮罩关闭，
 * 关闭后焦点还给打开它的那个元素。
 */
export default function FeedbackDialog({ initialContext, initialType, onClose, onSubmitted, fetchImpl }: FeedbackDialogProps) {
    const t = useSiteT();
    const [type, setType] = useState<FeedbackKind>(initialType);
    const [context, setContext] = useState<FeedbackContext | null>(initialContext);
    const [text, setText] = useState('');
    const [contact, setContact] = useState('');
    const [status, setStatus] = useState<'idle' | 'submitting' | 'done'>('idle');
    const [error, setError] = useState('');
    const panelRef = useRef<HTMLDivElement>(null);
    const textRef = useRef<HTMLTextAreaElement>(null);
    const titleId = useId();

    const quote = clampQuote(context?.quote);
    const budget = contentBudget(context?.quote);
    const option = FEEDBACK_TYPES.find((t) => t.value === type) ?? FEEDBACK_TYPES[0];
    const isPrivate = type === 'contact';

    // 锁滚动；焦点进弹窗，关闭时还回去
    useEffect(() => {
        const returnTo = document.activeElement as HTMLElement | null;
        const prevOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        textRef.current?.focus();
        return () => {
            document.body.style.overflow = prevOverflow;
            returnTo?.focus?.();
        };
    }, []);

    // 成功后焦点移到「关闭」，读屏能听到结果
    useEffect(() => {
        if (status === 'done') panelRef.current?.querySelector<HTMLElement>('.og-fb-done button')?.focus();
    }, [status]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                onClose();
                return;
            }
            if (e.key !== 'Tab' || !panelRef.current) return;
            const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
            if (items.length === 0) return;
            const first = items[0];
            const last = items[items.length - 1];
            const active = document.activeElement;
            if (e.shiftKey && (active === first || !panelRef.current.contains(active))) {
                e.preventDefault();
                last.focus();
            } else if (!e.shiftKey && (active === last || !panelRef.current.contains(active))) {
                e.preventDefault();
                first.focus();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    const canSubmit = text.trim().length > 0 && text.length <= budget && status === 'idle';

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!canSubmit) return;
        setStatus('submitting');
        setError('');
        try {
            await submitFeedback(
                buildFeedbackBody({ type, text, contact, context, pageUrl: window.location.href }),
                fetchImpl,
                t,
            );
            setStatus('done');
            onSubmitted?.();
        } catch (err) {
            setError(err instanceof Error ? err.message : t('feedback.submitFailed'));
            setStatus('idle');
        }
    };

    return (
        <div className="og-fb-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            <div ref={panelRef} className="og-fb-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
                <div className="og-fb-head">
                    <h2 id={titleId}>{t('feedback.dialog.title')}</h2>
                    <button type="button" className="og-fb-close" onClick={onClose} aria-label={t('feedback.dialog.close')}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                            <path d="M6 6l12 12M18 6L6 18" />
                        </svg>
                    </button>
                </div>

                {status === 'done' ? (
                    <div className="og-fb-done" role="status">
                        <p>{t('feedback.dialog.thanks')}</p>
                        <p className="og-fb-note">
                            {isPrivate
                                ? t('feedback.dialog.privateDone')
                                : <>{t('feedback.dialog.progressBefore')}<Link href="/feedback" onClick={onClose}>{t('feedback.dialog.listLink')}</Link>{t('feedback.dialog.progressAfter')}</>}
                        </p>
                        <button type="button" className="og-fb-submit" onClick={onClose}>{t('feedback.dialog.close')}</button>
                    </div>
                ) : (
                    <form onSubmit={submit} noValidate>
                        <div className="og-fb-types" role="radiogroup" aria-label={t('feedback.dialog.typeGroup')}>
                            {FEEDBACK_TYPES.map((o) => (
                                <button
                                    key={o.value}
                                    type="button"
                                    role="radio"
                                    aria-checked={o.value === type}
                                    onClick={() => setType(o.value)}
                                >
                                    {t(o.labelKey)}
                                </button>
                            ))}
                        </div>

                        {context && (context.label || quote) && (
                            <div className="og-fb-context">
                                <div className="og-fb-context-head">
                                    <span>{t('feedback.dialog.about')}</span>
                                    <button type="button" onClick={() => setContext(null)}>{t('feedback.dialog.detach')}</button>
                                </div>
                                {context.label && <div>{context.label}</div>}
                                {quote && <q className="og-fb-quote">{quote}</q>}
                            </div>
                        )}

                        <label className="og-fb-sr" htmlFor={`${titleId}-text`}>{t('feedback.dialog.contentLabel')}</label>
                        <textarea
                            id={`${titleId}-text`}
                            ref={textRef}
                            className="og-fb-field og-fb-text"
                            value={text}
                            onChange={(e) => setText(e.target.value)}
                            placeholder={t(option.placeholderKey)}
                            maxLength={budget}
                            rows={5}
                        />
                        {text.length > budget - 200 && (
                            <div className="og-fb-count">{text.length} / {budget}</div>
                        )}

                        <label className="og-fb-sr" htmlFor={`${titleId}-contact`}>{t('feedback.dialog.contactLabel')}</label>
                        <input
                            id={`${titleId}-contact`}
                            className="og-fb-field og-fb-contact"
                            value={contact}
                            onChange={(e) => setContact(e.target.value)}
                            placeholder={t(isPrivate ? 'feedback.dialog.contactPlaceholderPrivate' : 'feedback.dialog.contactPlaceholder')}
                            maxLength={CONTACT_MAX}
                            autoComplete="email"
                        />

                        {error && <p className="og-fb-error" role="alert">{error}</p>}

                        <div className="og-fb-foot">
                            <p className="og-fb-note">
                                {isPrivate
                                    ? t('feedback.dialog.privateNote')
                                    : <>{t('feedback.dialog.publicBefore')}<Link href="/feedback" onClick={onClose}>{t('feedback.dialog.listLink')}</Link>{t('feedback.dialog.publicAfter')}</>}
                            </p>
                            <button type="submit" className="og-fb-submit" disabled={!canSubmit}>
                                {status === 'submitting' ? t('feedback.dialog.submitting') : t('feedback.dialog.submit')}
                            </button>
                        </div>
                    </form>
                )}
            </div>
        </div>
    );
}
