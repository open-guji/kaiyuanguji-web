'use client';

import { useSearchParams } from 'next/navigation';
import ProofHeader, { type ProofBookInfo } from '@/components/proof/ProofHeader';
import { useSource } from '@/components/common/SourceContext';
import { getTransport } from '@/lib/transport';
import { readerPath } from '@/lib/reader-route';
import { useEffect, useMemo, useState } from 'react';
import {
    EMPTY_THREAD, NAME_MAX, REPLY_MAX, groupFixes, isFixBook, isFixVol, loadFixes, parsePublicFixes, parsePublicThreads, submitThread,
    type FixGroup, type FixKind, type FixThread, type Stance,
} from '@/lib/fixes';
import { useSiteT } from '@/i18n/use-site-t';
import type { SiteT } from '@/i18n/translate';

const KINDS: FixKind[] = ['char', 'span', 'entity'];

function where(t: SiteT, cell: string, key: 'charfix.list.where' | 'charfix.list.toEnd' = 'charfix.list.where') {
    const [page, col, slot] = cell.replace(/[ab]$/, '').split(':');
    return t(key, { page, col, slot });
}

const day = (ts?: number) => (ts ? new Date(ts).toISOString().slice(0, 10) : '');

const NAME_KEY = 'kyg-th-name';
const readName = () => { try { return localStorage.getItem(NAME_KEY) ?? ''; } catch { return ''; } };
const saveName = (n: string) => { try { localStorage.setItem(NAME_KEY, n); } catch { /* 存不了就算了 */ } };

/**
 * 一处意见下的讨论：同意／有不同看法（匿名、一人一票可改）与回复（留称呼）。
 * 本页先读 /api/fixes（实时读 KV），刚提交的表态与回复刷新即可见；本页不重新拉清单，刚发的回复先标「刚刚」显示在本地。
 */
function Thread({ t, th, book, vol, target, fetchImpl }: { t: SiteT; th: FixThread; book: string; vol: string; target: string; fetchImpl?: typeof fetch }) {
    const [stance, setStance] = useState<Stance | null>(null);
    const [open, setOpen] = useState(false);
    const [name, setName] = useState('');
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [mine, setMine] = useState<{ name: string; text: string }[]>([]);
    const msgs = { rate: t('charfix.error.rate'), failed: (status: number) => t('charfix.error.failed', { status }), network: t('charfix.error.network') };

    const send = async (s: Stance) => {
        if (busy) return;
        setBusy(true);
        setError('');
        const err = await submitThread({ book, volume: vol, target, stance: s, ...(s === 'reply' ? { name: name.trim(), text: text.trim() } : {}) }, msgs, fetchImpl);
        setBusy(false);
        if (err) return setError(err);
        if (s === 'reply') {
            saveName(name.trim());
            setMine((m) => [...m, { name: name.trim(), text: text.trim() }]);
            setText('');
            setOpen(false);
        } else setStance(s);
    };
    const canReply = !!name.trim() && [...name.trim()].length <= NAME_MAX && !!text.trim();

    return (
        <div className="og-fx-thread">
            <div className="og-fx-votes">
                <span className="og-fx-tally">{t('charfix.list.thread.tally', { a: th.agree, d: th.disagree })}</span>
                {(['agree', 'disagree'] as const).map((s) => (
                    <button key={s} type="button" aria-pressed={stance === s} disabled={busy} onClick={() => send(s)}>{t(`charfix.list.thread.${s}`)}</button>
                ))}
                <button type="button" onClick={() => { setOpen((o) => !o); if (!name) setName(readName()); }}>{t('charfix.list.thread.reply')}</button>
            </div>
            {stance && <p className="og-fx-ok" role="status">{t('charfix.list.thread.voted')}</p>}
            {(th.replies.length > 0 || mine.length > 0) && (
                <ul className="og-fx-replies">
                    {th.replies.map((r, i) => <li key={i} className={r.team ? 'og-fx-team' : undefined}><b>{r.name}</b>{r.team && <span className="og-fx-teamtag">{t('charfix.list.team')}</span>} <span className="og-fx-date">{day(r.ts)}</span> {r.text}</li>)}
                    {mine.map((r, i) => <li key={`m${i}`}><b>{r.name}</b> <span className="og-fx-date">{t('charfix.list.thread.pending')}</span> {r.text}</li>)}
                </ul>
            )}
            {open && (
                <form className="og-fx-form" onSubmit={(e) => { e.preventDefault(); if (canReply) send('reply'); }} noValidate>
                    <input aria-label={t('charfix.list.thread.nameLabel')} className="og-fb-field" value={name} maxLength={NAME_MAX} onChange={(e) => setName(e.target.value)} placeholder={t('charfix.list.thread.namePlaceholder')} />
                    <textarea aria-label={t('charfix.list.thread.textLabel')} className="og-fb-field og-fb-text" rows={3} value={text} maxLength={REPLY_MAX} onChange={(e) => setText(e.target.value)} placeholder={t('charfix.list.thread.textPlaceholder')} />
                    <div className="og-fx-formfoot">
                        <span className="og-fx-date">{t('charfix.list.thread.note')}</span>
                        <button type="button" onClick={() => setOpen(false)}>{t('charfix.list.thread.cancel')}</button>
                        <button type="submit" className="og-fb-submit" disabled={!canReply || busy}>{busy ? t('charfix.list.thread.submitting') : t('charfix.list.thread.submit')}</button>
                    </div>
                </form>
            )}
            {error && <p className="og-fb-error" role="alert">{error}</p>}
        </div>
    );
}

/** 一处意见：位置（点了到阅读页该格）、类别、原文与建议、各条说明、讨论 */
function GroupRow({ t, g, book, vol, th, fetchImpl }: { t: SiteT; g: FixGroup; book: string; vol: string; th: FixThread; fetchImpl?: typeof fetch }) {
    const label = g.kind === 'span' ? t(`charfix.span.subs.${g.sub ?? 'other'}`) : t(`charfix.list.kinds.${g.kind}`);
    // 说是图形的意见单列「应是图形（说明）」，不写「应作「□」」
    const suggestions = [...new Set(g.items.map((x) => (x.fig ? t('charfix.list.figure', { alt: x.alt ? `（${x.alt}）` : '' }) : x.new ? t('charfix.list.suggest', { text: x.new }) : ''))
        .filter((x): x is string => !!x))];
    const versions = [...new Set(g.items.map((x) => x.tv).filter((x): x is string => !!x))];
    return (
        <li className="og-fx-row" data-testid="fix-group">
            <div className="og-fx-head">
                <span className="og-fx-kind">{label}</span>
                <a className="og-fx-where" href={`/read/${book}/${vol}#${g.at}`}>
                    {where(t, g.at)}{g.end && g.end !== g.at ? ` ${where(t, g.end, 'charfix.list.toEnd')}` : ''}
                </a>
            </div>
            {th.status && (
                <p className={`og-fx-status og-fx-status-${th.status.state}`} data-testid="fix-status">
                    <b>{t(`charfix.list.state.${th.status.state}`)}</b>
                    {th.status.version && <span>{t('charfix.list.stateVersion', { v: th.status.version })}</span>}
                    {th.status.reason && <span>{th.status.reason}</span>}
                </p>
            )}
            {(g.old || suggestions.length > 0) && (
                <div className="og-fx-body">
                    {g.old && <span className="og-fx-old">{g.kind === 'entity' ? t('charfix.list.entity', { text: g.old }) : t('charfix.list.now', { text: g.old })}</span>}
                    {suggestions.map((s) => <span key={s} className="og-fx-new">{s}</span>)}
                </div>
            )}
            {g.items.some((x) => x.note) && (
                <ul className="og-fx-notes">
                    {g.items.filter((x) => x.note).map((x, i) => <li key={i}>{x.note}</li>)}
                </ul>
            )}
            <div className="og-fx-meta">
                <span>{t('charfix.list.people', { n: g.people })}</span>
                {versions.length > 0 && <span>{t('charfix.list.version', { tv: versions.join('、') })}</span>}
                {g.latest > 0 && <span>{day(g.latest)}</span>}
            </div>
            <Thread t={t} th={th} book={book} vol={vol} target={g.target} fetchImpl={fetchImpl} />
        </li>
    );
}

export default function TextFixesContent({ fetchImpl }: { fetchImpl?: typeof fetch }) {
    const t = useSiteT();
    const params = useSearchParams();
    const book = params?.get('book') ?? '';
    const vol = params?.get('vol') ?? '';
    const ok = isFixBook(book) && isFixVol(vol);
    const [raw, setRaw] = useState<unknown | null | undefined>(undefined);
    const [kind, setKind] = useState<FixKind | ''>('');
    const { source } = useSource();
    const [info, setInfo] = useState<ProofBookInfo | null>(null);

    useEffect(() => {
        if (!isFixBook(book)) return;
        let live = true;
        const get = getTransport(source).getEntry;
        if (!get) return;
        Promise.resolve(getTransport(source).getEntry(book)).then((e) => {
            if (live && e?.title) setInfo({ title: e.title });
        }).catch(() => { /* 取不到书名就只显示状态标 */ });
        return () => { live = false; };
    }, [book, source]);

    useEffect(() => {
        if (!ok) return;
        let live = true;
        setRaw(undefined);
        loadFixes(book, vol, fetchImpl).then((r) => { if (live) setRaw(r); });
        return () => { live = false; };
    }, [book, vol, ok, fetchImpl]);

    const groups = useMemo(() => (raw ? groupFixes(parsePublicFixes(raw, vol)) : []), [raw, vol]);
    const threads = useMemo(() => parsePublicThreads(raw, vol), [raw, vol]);
    const shown = kind ? groups.filter((g) => g.kind === kind) : groups;
    const total = groups.reduce((s, g) => s + g.items.length, 0);

    return (
        <>
            <ProofHeader back={ok ? readerPath(book, { chapter: /^\d{3}$/.test(vol) ? vol : undefined }) : '/'} info={info}
                sub={ok ? t('charfix.list.volume', { vol }) : undefined} badge={t('charfix.list.badge')} />
            <div className="og-fx-page">
                {!ok ? <p role="alert">{t('charfix.list.badParams')}</p> : (
                    <>
                        <p className="og-fx-intro">{t('charfix.list.intro')}</p>
                        {raw === undefined && <p>{t('charfix.list.loading')}</p>}
                        {raw === null && <p role="alert">{t('charfix.list.failed')}</p>}
                        {raw && groups.length === 0 && <p>{t('charfix.list.empty')}</p>}
                        {groups.length > 0 && (
                            <>
                                <p className="og-fx-count">{t('charfix.list.count', { n: groups.length, m: total })}</p>
                                <div className="og-fx-tabs" role="tablist">
                                    {(['', ...KINDS] as const).map((k) => (
                                        <button key={k || 'all'} type="button" role="tab" aria-selected={kind === k} onClick={() => setKind(k)}>
                                            {k ? t(`charfix.list.kinds.${k}`) : t('charfix.list.all')}
                                        </button>
                                    ))}
                                </div>
                                <ol className="og-fx-list">
                                    {shown.map((g) => <GroupRow key={g.key} t={t} g={g} book={book} vol={vol} th={threads.get(g.target) ?? EMPTY_THREAD} fetchImpl={fetchImpl} />)}
                                </ol>
                            </>
                        )}
                    </>
                )}
            </div>
        </>
    );
}
