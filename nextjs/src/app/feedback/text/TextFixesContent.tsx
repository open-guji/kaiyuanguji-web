'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { groupFixes, isFixBook, isFixVol, loadPublicFixes, parsePublicFixes, type FixGroup, type FixKind } from '@/lib/fixes';
import { useSiteT } from '@/i18n/use-site-t';
import type { SiteT } from '@/i18n/translate';

const KINDS: FixKind[] = ['char', 'span', 'entity'];

function where(t: SiteT, cell: string, key: 'charfix.list.where' | 'charfix.list.toEnd' = 'charfix.list.where') {
    const [page, col, slot] = cell.replace(/[ab]$/, '').split(':');
    return t(key, { page, col, slot });
}

const day = (ts?: number) => (ts ? new Date(ts).toISOString().slice(0, 10) : '');

/** 一处意见：位置（点了到阅读页该格）、类别、原文与建议、各条说明 */
function GroupRow({ t, g, book, vol }: { t: SiteT; g: FixGroup; book: string; vol: string }) {
    const label = g.kind === 'span' ? t(`charfix.span.subs.${g.sub ?? 'other'}`) : t(`charfix.list.kinds.${g.kind}`);
    const suggestions = [...new Set(g.items.map((x) => x.new).filter((x): x is string => !!x))];
    const versions = [...new Set(g.items.map((x) => x.tv).filter((x): x is string => !!x))];
    return (
        <li className="og-fx-row" data-testid="fix-group">
            <div className="og-fx-head">
                <a className="og-fx-where" href={`/read/${book}/${vol}#${g.at}`}>
                    {where(t, g.at)}{g.end && g.end !== g.at ? ` ${where(t, g.end, 'charfix.list.toEnd')}` : ''}
                </a>
                <span className="og-fx-kind">{label}</span>
                <span className="og-fx-people">{t('charfix.list.people', { n: g.people })}</span>
            </div>
            <div className="og-fx-body">
                {g.old && <span>{g.kind === 'entity' ? t('charfix.list.entity', { text: g.old }) : t('charfix.list.now', { text: g.old })}</span>}
                {suggestions.map((s) => <span key={s} className="og-fx-new">{t('charfix.list.suggest', { text: s })}</span>)}
                {versions.length > 0 && <span className="og-fx-tv">{t('charfix.list.version', { tv: versions.join('、') })}</span>}
            </div>
            {g.items.some((x) => x.note) && (
                <ul className="og-fx-notes">
                    {g.items.filter((x) => x.note).map((x, i) => <li key={i}><span className="og-fx-date">{day(x.ts)}</span> {x.note}</li>)}
                </ul>
            )}
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

    useEffect(() => {
        if (!ok) return;
        let live = true;
        setRaw(undefined);
        loadPublicFixes(book, fetchImpl).then((r) => { if (live) setRaw(r); });
        return () => { live = false; };
    }, [book, ok, fetchImpl]);

    const groups = useMemo(() => (raw ? groupFixes(parsePublicFixes(raw, vol)) : []), [raw, vol]);
    const shown = kind ? groups.filter((g) => g.kind === kind) : groups;
    const total = groups.reduce((s, g) => s + g.items.length, 0);

    return (
        <div className="og-fx-page">
            <h1>{ok ? t('charfix.list.heading', { vol }) : t('charfix.list.title')}</h1>
            <p className="og-fx-intro">{t('charfix.list.intro')}</p>
            {!ok ? <p role="alert">{t('charfix.list.badParams')}</p> : (
                <>
                    <p><Link href={`/read/${book}/${vol}`}>{t('charfix.list.back')}</Link></p>
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
                                {shown.map((g) => <GroupRow key={g.key} t={t} g={g} book={book} vol={vol} />)}
                            </ol>
                        </>
                    )}
                </>
            )}
        </div>
    );
}

