'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import {
    BASIS_MAX, NOTE_MAX, canFixChar, cellIdOf, isNewChar, reportableEntitiesAt, submitCharFix, submitEntityFix,
    type CharFixCtx, type CharFixEntity,
} from '@/lib/charfix';
import { useSiteT } from '@/i18n/use-site-t';
import type { SiteT } from '@/i18n/translate';

interface Props {
    /** 阅读器正文所在的外框：只认这里面的字 */
    containerRef: RefObject<HTMLElement | null>;
    /** 本章改字上下文（阅读器取到对读数据时填）；返回 null＝本章不是对读章，不出入口。要稳定引用（useCallback） */
    getCtx: () => CharFixCtx | null;
    /** 测试注入；默认全局 fetch */
    fetchImpl?: typeof fetch;
}

/** 浮条离视口边的最小距离 */
const EDGE = 8;

interface At {
    cell: string;
    left: number;
    top: number;
    below: boolean;
    /** 被点字的上沿：浮条在下方放不下时翻到上方用 */
    charTop: number;
}

/** 「第 4 页 3 列 8 格」：格位去掉夹注 a／b 后缀 */
function whereOf(t: SiteT, cell: string) {
    const [page, col, slot] = cell.replace(/[ab]$/, '').split(':');
    return t('charfix.bar.where', { page, col, slot });
}

/**
 * 阅读页「改字」入口（GUJI-561）。点一个对读章里的字，字旁边浮出一条「第 4 页 3 列 8 格「於」［改字］」（锚在字上，不占视口底部，
 * 盖不到书影翻页等控件；手机宽度也点得到）；点「改字」弹出建议字＋依据的小弹窗。纯 .txt 章没有 data-char-id，自然没有入口。
 * 字落在某个专名的 anchor 区间里时，浮条再多一个「专名有误」（GUJI-590），提交 kind=entity 记录。
 * 本章缺文本版本时不收改字，浮条里写明（专名意见不受影响）。
 * 选区拖选时不弹（那是「复制／报错」浮条的事）。
 */
export default function CharFixEntry({ containerRef, getCtx, fetchImpl }: Props) {
    const t = useSiteT();
    const [at, setAt] = useState<At | null>(null);
    const [open, setOpen] = useState<'char' | 'entity' | null>(null);
    const openRef = useRef(false);
    openRef.current = open !== null;
    const barRef = useRef<HTMLDivElement>(null);

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
                left: rect.left + rect.width / 2,
                top: below ? rect.bottom + EDGE : rect.top - EDGE,
                below,
                charTop: rect.top,
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

    // 画出来以后按浮条实际尺寸夹进视口（GUJI-590）：触屏上字贴视口底时，下方放不下就翻到字上方，上方也放不下就贴底；
    // 左右同理（浮条宽度随文案、按钮多少而变，不再按固定半宽估）。挪过一次后再量就在视口内，不会来回跳
    useLayoutEffect(() => {
        const el = barRef.current;
        if (!at || !el) return;
        const r = el.getBoundingClientRect();
        if (!r.width && !r.height) return; // 没有布局（测试环境、隐藏）就不动
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        let { left, top, below } = at;
        if (r.left < EDGE) left += EDGE - r.left;
        else if (r.right > vw - EDGE) left -= r.right - (vw - EDGE);
        if (below && r.bottom > vh - EDGE) {
            if (at.charTop - EDGE - r.height >= EDGE) { below = false; top = at.charTop - EDGE; }
            else top -= r.bottom - (vh - EDGE);
        } else if (!below && r.top < EDGE) {
            top += EDGE - r.top;
        }
        if (left !== at.left || top !== at.top || below !== at.below) setAt({ ...at, left, top, below });
    }, [at]);

    const ctx = getCtx();
    if (!at || !ctx) return null;
    const cell = at.cell;
    const orig = ctx.chars.get(cell) ?? '';
    const fixable = canFixChar(ctx);
    const ents = reportableEntitiesAt(cell, ctx);

    return (
        <>
            <div
                ref={barRef}
                className={at.below ? 'og-cf-bar og-cf-bar--below' : 'og-cf-bar'}
                style={{ left: at.left, top: at.top }}
                role="toolbar"
                aria-label={t('charfix.bar.label')}
            >
                <span className="og-cf-where">{whereOf(t, cell)}{orig && <>「{orig}」</>}</span>
                {fixable
                    ? <button type="button" className="og-cf-go" onClick={() => setOpen('char')}>{t('charfix.bar.fix')}</button>
                    : <span className="og-cf-off">{t('charfix.bar.noVersion')}</span>}
                {ents.length > 0 && <button type="button" className="og-cf-go" onClick={() => setOpen('entity')}>{t('charfix.bar.entity')}</button>}
                <button type="button" className="og-cf-x" onClick={() => setAt(null)} aria-label={t('charfix.bar.close')}>×</button>
            </div>
            {open === 'char' && fixable && <CharFixDialog t={t} ctx={ctx} cell={cell} orig={orig} fetchImpl={fetchImpl} onClose={() => setOpen(null)} />}
            {open === 'entity' && ents.length > 0 && <EntityFixDialog t={t} ctx={ctx} entities={ents} fetchImpl={fetchImpl} onClose={() => setOpen(null)} />}
        </>
    );
}

/** 两个弹窗共用：Esc 关、提交中／已收到、错误文案 */
export function useDialog(onClose: () => void) {
    const [status, setStatus] = useState<'idle' | 'submitting' | 'done'>('idle');
    const [error, setError] = useState('');
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);
    const run = async (send: () => Promise<string | null>) => {
        if (status !== 'idle') return;
        setStatus('submitting');
        setError('');
        const err = await send();
        if (err) { setError(err); setStatus('idle'); } else setStatus('done');
    };
    return { status, error, run };
}

export function DialogFrame({ t, title, titleId, onClose, done, children }: { t: SiteT; title: string; titleId: string; onClose: () => void; done: string | null; children: React.ReactNode }) {
    return (
        <div className="og-fb-mask" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
            <div className="og-fb-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
                <div className="og-fb-head">
                    <h2 id={titleId}>{title}</h2>
                    <button type="button" className="og-fb-close" onClick={onClose} aria-label={t('charfix.dialog.close')}>×</button>
                </div>
                {done !== null ? (
                    <div className="og-fb-done" role="status">
                        <p>{done}</p>
                        <button type="button" className="og-fb-submit" onClick={onClose}>{t('charfix.dialog.close')}</button>
                    </div>
                ) : children}
            </div>
        </div>
    );
}

function CharFixDialog({ t, ctx, cell, orig, fetchImpl, onClose }: { t: SiteT; ctx: CharFixCtx; cell: string; orig: string; fetchImpl?: typeof fetch; onClose: () => void }) {
    const [newChar, setNewChar] = useState('');
    const [basis, setBasis] = useState('');
    const { status, error, run } = useDialog(onClose);
    const inputRef = useRef<HTMLInputElement>(null);
    const titleId = useId();
    useEffect(() => { inputRef.current?.focus(); }, []);

    const nc = newChar.trim();
    const valid = isNewChar(nc) && nc !== orig;
    const submit = (e: React.FormEvent) => {
        e.preventDefault();
        if (valid) run(() => submitCharFix(ctx, { cell, newChar: nc, basis: basis.trim() }, fetchImpl, t));
    };

    return (
        <DialogFrame t={t} title={t('charfix.dialog.title')} titleId={titleId} onClose={onClose} done={status === 'done' ? t('charfix.dialog.done') : null}>
            <form onSubmit={submit} noValidate>
                <div className="og-fb-context">
                    <div>{t('charfix.dialog.cell', { cell })}{orig && t('charfix.dialog.now', { char: orig })}</div>
                </div>
                <label className="og-fb-sr" htmlFor={`${titleId}-new`}>{t('charfix.dialog.newLabel')}</label>
                <input
                    id={`${titleId}-new`}
                    ref={inputRef}
                    className="og-fb-field og-fb-contact"
                    value={newChar}
                    onChange={e => setNewChar(e.target.value)}
                    placeholder={t('charfix.dialog.newPlaceholder')}
                    maxLength={34}
                    autoComplete="off"
                />
                <label className="og-fb-sr" htmlFor={`${titleId}-basis`}>{t('charfix.dialog.basisLabel')}</label>
                <textarea
                    id={`${titleId}-basis`}
                    className="og-fb-field og-fb-text"
                    value={basis}
                    onChange={e => setBasis(e.target.value)}
                    placeholder={t('charfix.dialog.basisPlaceholder')}
                    maxLength={BASIS_MAX}
                    rows={3}
                />
                {nc && !valid && <p className="og-fb-error" role="alert">{nc === orig ? t('charfix.dialog.same') : t('charfix.dialog.notOne')}</p>}
                {error && <p className="og-fb-error" role="alert">{error}</p>}
                <div className="og-fb-foot">
                    <p className="og-fb-note">{t('charfix.dialog.note')}</p>
                    <button type="submit" className="og-fb-submit" disabled={!valid || status !== 'idle'}>
                        {status === 'submitting' ? t('charfix.dialog.submitting') : t('charfix.dialog.submit')}
                    </button>
                </div>
            </form>
        </DialogFrame>
    );
}

/** 「专名有误」：选哪个专名（一格落在几个专名里时）＋说明哪里有误（接口要求 note 必填） */
function EntityFixDialog({ t, ctx, entities, fetchImpl, onClose }: { t: SiteT; ctx: CharFixCtx; entities: CharFixEntity[]; fetchImpl?: typeof fetch; onClose: () => void }) {
    const [pick, setPick] = useState(0);
    const [note, setNote] = useState('');
    const { status, error, run } = useDialog(onClose);
    const noteRef = useRef<HTMLTextAreaElement>(null);
    const titleId = useId();
    useEffect(() => { noteRef.current?.focus(); }, []);

    const entity = entities[Math.min(pick, entities.length - 1)];
    const n = note.trim();
    const label = (e: CharFixEntity) => {
        const [page, col, slot] = e.start.replace(/[ab]$/, '').split(':');
        return t('charfix.entity.which', { text: e.text, page, col, slot });
    };
    const submit = (e: React.FormEvent) => {
        e.preventDefault();
        if (n) run(() => submitEntityFix(ctx, { entity, note: n }, fetchImpl, t));
    };

    return (
        <DialogFrame t={t} title={t('charfix.entity.title')} titleId={titleId} onClose={onClose} done={status === 'done' ? t('charfix.entity.done') : null}>
            <form onSubmit={submit} noValidate>
                <div className="og-fb-context">
                    {entities.length === 1 ? (
                        <div>{label(entity)}</div>
                    ) : (
                        <>
                            <label className="og-fb-sr" htmlFor={`${titleId}-pick`}>{t('charfix.entity.pick')}</label>
                            <select id={`${titleId}-pick`} className="og-fb-field" value={pick} onChange={e => setPick(Number(e.target.value))}>
                                {entities.map((e, i) => <option key={e.id} value={i}>{label(e)}</option>)}
                            </select>
                        </>
                    )}
                </div>
                <label className="og-fb-sr" htmlFor={`${titleId}-note`}>{t('charfix.entity.noteLabel')}</label>
                <textarea
                    id={`${titleId}-note`}
                    ref={noteRef}
                    className="og-fb-field og-fb-text"
                    value={note}
                    onChange={e => setNote(e.target.value)}
                    placeholder={t('charfix.entity.notePlaceholder')}
                    maxLength={NOTE_MAX}
                    rows={3}
                />
                {error && <p className="og-fb-error" role="alert">{error}</p>}
                <div className="og-fb-foot">
                    <p className="og-fb-note">{t('charfix.dialog.note')}</p>
                    <button type="submit" className="og-fb-submit" disabled={!n || status !== 'idle'}>
                        {status === 'submitting' ? t('charfix.dialog.submitting') : t('charfix.dialog.submit')}
                    </button>
                </div>
            </form>
        </DialogFrame>
    );
}
