'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { NOTE_MAX, SPAN_SUBS, SPAN_TEXT_MAX, submitSpanFix, type CharFixCtx, type SpanSel, type SpanSub } from '@/lib/charfix';
import { DialogFrame, useDialog } from '@/components/CharFixEntry';
import type { SiteT } from '@/i18n/translate';
import { fixesPageHref } from '@/lib/fixes';

interface Props {
    t: SiteT;
    ctx: CharFixCtx;
    span: SpanSel;
    onClose: () => void;
    /** 测试注入；默认全局 fetch */
    fetchImpl?: typeof fetch;
}

/**
 * 拖选一段字后「報錯」的弹窗（kind=span，GUJI-597 反馈设计）：选哪类问题（错字、缺字、多字、次序、标点、分段、标题、小注、专名、其他），
 * 选填「應作」（这段正确的样子）与「說明」，两项至少一项。首末格位、选中的原字自动带上，读者不用描述位置。
 */
export default function SpanFixDialog({ t, ctx, span, onClose, fetchImpl }: Props) {
    const [sub, setSub] = useState<SpanSub>('wrong');
    const [newText, setNewText] = useState('');
    const [note, setNote] = useState('');
    const { status, error, run } = useDialog(onClose);
    const selRef = useRef<HTMLSelectElement>(null);
    const titleId = useId();
    useEffect(() => { selRef.current?.focus(); }, []);

    const [page, col, slot] = span.start.replace(/[ab]$/, '').split(':');
    const nt = newText.trim();
    const n = note.trim();
    const same = !!nt && nt === span.text;
    const valid = (!!nt || !!n) && !same;
    const submit = (e: React.FormEvent) => {
        e.preventDefault();
        if (valid) run(() => submitSpanFix(ctx, { span, sub, newText: nt, note: n }, fetchImpl, t));
    };

    return (
        <DialogFrame t={t} title={t('charfix.span.title')} titleId={titleId} onClose={onClose} done={status === 'done' ? t('charfix.span.done') : null} doneLink={fixesPageHref(ctx.book, ctx.volume)}>
            <form onSubmit={submit} noValidate>
                <div className="og-fb-context">
                    <div>{t('charfix.span.where', { page, col, slot, count: span.count })}</div>
                    {span.text && <div>{t('charfix.span.quote', { text: span.text })}</div>}
                </div>
                <label className="og-fb-sr" htmlFor={`${titleId}-sub`}>{t('charfix.span.subLabel')}</label>
                <select id={`${titleId}-sub`} ref={selRef} className="og-fb-field" value={sub} onChange={e => setSub(e.target.value as SpanSub)}>
                    {SPAN_SUBS.map(s => <option key={s} value={s}>{t(`charfix.span.subs.${s}`)}</option>)}
                </select>
                <label className="og-fb-sr" htmlFor={`${titleId}-new`}>{t('charfix.span.newLabel')}</label>
                <input
                    id={`${titleId}-new`}
                    className="og-fb-field og-fb-contact"
                    value={newText}
                    onChange={e => setNewText(e.target.value)}
                    placeholder={t('charfix.span.newPlaceholder')}
                    maxLength={SPAN_TEXT_MAX}
                    autoComplete="off"
                />
                <label className="og-fb-sr" htmlFor={`${titleId}-note`}>{t('charfix.span.noteLabel')}</label>
                <textarea
                    id={`${titleId}-note`}
                    className="og-fb-field og-fb-text"
                    value={note}
                    onChange={e => setNote(e.target.value)}
                    placeholder={t('charfix.span.notePlaceholder')}
                    maxLength={NOTE_MAX}
                    rows={3}
                />
                {same && <p className="og-fb-error" role="alert">{t('charfix.span.same')}</p>}
                {error && <p className="og-fb-error" role="alert">{error}</p>}
                <div className="og-fb-foot">
                    <p className="og-fb-note">{valid || same ? t('charfix.dialog.note') : t('charfix.span.need')}</p>
                    <button type="submit" className="og-fb-submit" disabled={!valid || status !== 'idle'}>
                        {status === 'submitting' ? t('charfix.dialog.submitting') : t('charfix.dialog.submit')}
                    </button>
                </div>
            </form>
        </DialogFrame>
    );
}
