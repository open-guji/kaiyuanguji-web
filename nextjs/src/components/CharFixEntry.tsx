'use client';

import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { BASIS_MAX, cellIdOf, isNewChar, submitCharFix, type CharFixCtx } from '@/lib/charfix';

interface Props {
    /** 阅读器正文所在的外框：只认这里面的字 */
    containerRef: RefObject<HTMLElement | null>;
    /** 本章改字上下文（阅读器取到对读数据时填）；返回 null＝本章不是对读章，不出入口。要稳定引用（useCallback） */
    getCtx: () => CharFixCtx | null;
    /** 测试注入；默认全局 fetch */
    fetchImpl?: typeof fetch;
}

/**
 * 阅读页「改字」入口（GUJI-561）。点一个对读章里的字，字旁边浮出一条「第 4 页 3 列 8 格「於」［改字］」（锚在字上，不占视口底部，
 * 盖不到书影翻页等控件；手机宽度也点得到）；点「改字」弹出建议字＋依据的小弹窗。纯 .txt 章没有 data-char-id，自然没有入口。
 * 选区拖选时不弹（那是「复制／报错」浮条的事）。
 */
export default function CharFixEntry({ containerRef, getCtx, fetchImpl }: Props) {
    const [at, setAt] = useState<{ cell: string; left: number; top: number; below: boolean } | null>(null);
    const [open, setOpen] = useState(false);
    const openRef = useRef(false);
    openRef.current = open;

    useEffect(() => {
        const root = containerRef.current;
        if (!root) return;
        const onClick = (e: MouseEvent) => {
            const sel = window.getSelection();
            if (sel && !sel.isCollapsed) return;
            const id = getCtx() ? cellIdOf(e.target) : null;
            const el = id ? (e.target as Element).closest('[data-char-id]') : null;
            if (!id || !el) return setAt(null);
            const rect = el.getBoundingClientRect();
            // 同选字浮条：桌面浮在字上方，触屏放字下方（免得和系统选字菜单打架）；锚在字旁边，不占视口底部，盖不到书影翻页等控件
            const below = (window.matchMedia?.('(pointer: coarse)').matches ?? false) || rect.top < 56; // 字在视口最上沿时上方放不下，也放下方
            setAt({
                cell: id,
                left: Math.min(Math.max(rect.left + rect.width / 2, 110), window.innerWidth - 110),
                top: below ? rect.bottom + 8 : rect.top - 8,
                below,
            });
        };
        // fixed 定位：滚动、缩放后位置就不对了，先收起
        const hide = () => { if (!openRef.current) setAt(null); }; // 弹窗开着时不收（弹窗要用 at 里的格位）
        root.addEventListener('click', onClick);
        window.addEventListener('scroll', hide, true);
        window.addEventListener('resize', hide);
        return () => {
            root.removeEventListener('click', onClick);
            window.removeEventListener('scroll', hide, true);
            window.removeEventListener('resize', hide);
        };
    }, [containerRef, getCtx]);

    const ctx = getCtx();
    if (!at || !ctx) return null;
    const cell = at.cell;
    const [page, col, slot] = cell.replace(/[ab]$/, '').split(':');
    const orig = ctx.chars.get(cell) ?? '';

    return (
        <>
            <div
                className={at.below ? 'og-cf-bar og-cf-bar--below' : 'og-cf-bar'}
                style={{ left: at.left, top: at.top }}
                role="toolbar"
                aria-label="改字"
            >
                <span className="og-cf-where">第 {page} 頁 {col} 列 {slot} 格{orig && <>「{orig}」</>}</span>
                <button type="button" className="og-cf-go" onClick={() => setOpen(true)}>改字</button>
                <button type="button" className="og-cf-x" onClick={() => setAt(null)} aria-label="關閉">×</button>
            </div>
            {open && <CharFixDialog ctx={ctx} cell={cell} orig={orig} fetchImpl={fetchImpl} onClose={() => setOpen(false)} />}
        </>
    );
}

function CharFixDialog({ ctx, cell, orig, fetchImpl, onClose }: { ctx: CharFixCtx; cell: string; orig: string; fetchImpl?: typeof fetch; onClose: () => void }) {
    const [newChar, setNewChar] = useState('');
    const [basis, setBasis] = useState('');
    const [status, setStatus] = useState<'idle' | 'submitting' | 'done'>('idle');
    const [error, setError] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);
    const titleId = useId();

    useEffect(() => {
        inputRef.current?.focus();
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    const nc = newChar.trim();
    const valid = isNewChar(nc) && nc !== orig;
    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!valid || status !== 'idle') return;
        setStatus('submitting');
        setError('');
        const err = await submitCharFix(ctx, { cell, newChar: nc, basis: basis.trim() }, fetchImpl);
        if (err) { setError(err); setStatus('idle'); } else setStatus('done');
    };

    return (
        <div className="og-fb-mask" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
            <div className="og-fb-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
                <div className="og-fb-head">
                    <h2 id={titleId}>改字</h2>
                    <button type="button" className="og-fb-close" onClick={onClose} aria-label="關閉">×</button>
                </div>
                {status === 'done' ? (
                    <div className="og-fb-done" role="status">
                        <p>已收到，謝謝。我們核對後會在整理本中更正。</p>
                        <button type="button" className="og-fb-submit" onClick={onClose}>關閉</button>
                    </div>
                ) : (
                    <form onSubmit={submit} noValidate>
                        <div className="og-fb-context">
                            <div>格位 {cell}{orig && <>，現作「{orig}」</>}</div>
                        </div>
                        <label className="og-fb-sr" htmlFor={`${titleId}-new`}>建議字</label>
                        <input
                            id={`${titleId}-new`}
                            ref={inputRef}
                            className="og-fb-field og-fb-contact"
                            value={newChar}
                            onChange={e => setNewChar(e.target.value)}
                            placeholder="應作哪個字？造字可寫 {{⿰虫斤}}"
                            maxLength={34}
                            autoComplete="off"
                        />
                        <label className="og-fb-sr" htmlFor={`${titleId}-basis`}>依據</label>
                        <textarea
                            id={`${titleId}-basis`}
                            className="og-fb-field og-fb-text"
                            value={basis}
                            onChange={e => setBasis(e.target.value)}
                            placeholder="依據（選填）：他本作什麼、書影第幾頁、或截圖鏈接"
                            maxLength={BASIS_MAX}
                            rows={3}
                        />
                        {nc && !valid && <p className="og-fb-error" role="alert">{nc === orig ? '建議字與原字相同' : '請填一個字，或用 {{組字式}}'}</p>}
                        {error && <p className="og-fb-error" role="alert">{error}</p>}
                        <div className="og-fb-foot">
                            <p className="og-fb-note">只提出建議，不會直接改動正文；匿名提交。</p>
                            <button type="submit" className="og-fb-submit" disabled={!valid || status !== 'idle'}>
                                {status === 'submitting' ? '提交中…' : '提交'}
                            </button>
                        </div>
                    </form>
                )}
            </div>
        </div>
    );
}
