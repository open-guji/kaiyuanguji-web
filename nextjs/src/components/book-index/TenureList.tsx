'use client';

import { useConvert, type IndexDetailData } from 'book-index-ui';
import { useSiteT } from '@/i18n/use-site-t';
import BidLink from './BidLink';

/**
 * 官职页「历任者」、地名页「历任长官」。
 *
 * 数据是 book-index build 派生的任官反查（#2330，TenureCard）：
 *   office 条 `_holders`（每条带 `place`），place 条 `_officials`（每条带 `office`），
 *   `*_total` 是反查总数（超过 300 卡时大于卡数）。条目页没有这些键就不出这个标签。
 * 卡片按任职年排好，网站不再排序；枢纽人物卡只有 `{id, h:1}`，名字交给 BidLink 自取。
 */
export interface TenureCard {
    id: string;
    name?: string;
    dyn?: string;
    text?: string;
    kind?: string;
    start?: number;
    end?: number;
    place?: { id: string; name?: string };
    office?: { id: string; name?: string };
}

export type TenureMode = 'holders' | 'officials';

type TenureFields = {
    subtype?: string;
    _holders?: TenureCard[];
    _holders_total?: number;
    _officials?: TenureCard[];
    _officials_total?: number;
};

/** 条目有可显示的反查数据时返回模式，否则 null（标签随之不出现） */
export function tenureModeOf(detail: IndexDetailData | Record<string, unknown> | null | undefined): TenureMode | null {
    const d = detail as TenureFields | null | undefined;
    if (!d) return null;
    if (d.subtype === 'office' && Array.isArray(d._holders) && d._holders.length > 0) return 'holders';
    if (d.subtype === 'place' && Array.isArray(d._officials) && d._officials.length > 0) return 'officials';
    return null;
}

type T = ReturnType<typeof useSiteT>;

function yearLabel(t: T, c: TenureCard): string {
    const f = (y: number) => (y < 0 ? t('bookIndex.tenure.bc', { y: String(-y) }) : String(y));
    const { start, end } = c;
    if (start == null && end == null) return t('bookIndex.tenure.yearUnknown');
    if (start != null && end != null) {
        return start === end
            ? t('bookIndex.tenure.year', { y: f(start) })
            : t('bookIndex.tenure.yearRange', { a: f(start), b: f(end) });
    }
    if (start != null) return t('bookIndex.tenure.yearFrom', { y: f(start) });
    return t('bookIndex.tenure.yearTo', { y: f(end as number) });
}

export default function TenureList({ detail }: { detail: IndexDetailData }) {
    const t = useSiteT();
    const { convert } = useConvert();
    const mode = tenureModeOf(detail);
    if (!mode) return null;
    const d = detail as unknown as TenureFields;
    const cards = (mode === 'holders' ? d._holders : d._officials) ?? [];
    const total = (mode === 'holders' ? d._holders_total : d._officials_total) ?? cards.length;

    return (
        <section className="px-4 pb-8" data-testid="tenure-list">
            <h2 className="sr-only">{t(mode === 'holders' ? 'bookIndex.tenure.holdersTitle' : 'bookIndex.tenure.officialsTitle')}</h2>
            <p className="text-sm text-muted-foreground mb-3" data-testid="tenure-total">
                {total > cards.length
                    ? t('bookIndex.tenure.capped', { n: String(total), shown: String(cards.length) })
                    : t('bookIndex.tenure.total', { n: String(total) })}
                <span className="ml-2 opacity-80">{t('bookIndex.tenure.hint')}</span>
            </p>
            <ol className="divide-y divide-black/10 dark:divide-white/10 border-y border-black/10 dark:border-white/10">
                {cards.map((c, i) => {
                    const ref = mode === 'holders' ? c.place : c.office;
                    return (
                        <li key={`${c.id}-${i}`} className="py-2.5 flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-4">
                            <span className="text-xs text-muted-foreground tabular-nums sm:w-32 sm:shrink-0">{yearLabel(t, c)}</span>
                            <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 min-w-0">
                                <BidLink id={c.id} showIcon={false}>{c.name ? convert(c.name) : undefined}</BidLink>
                                {c.dyn && <span className="text-xs text-muted-foreground">{convert(c.dyn)}</span>}
                                {ref && (
                                    <span className="text-sm">
                                        <span className="text-muted-foreground">· </span>
                                        <BidLink id={ref.id} showIcon={false}>{ref.name ? convert(ref.name) : undefined}</BidLink>
                                    </span>
                                )}
                                {c.text && <span className="text-sm text-muted-foreground">「{convert(c.text)}」</span>}
                            </span>
                        </li>
                    );
                })}
            </ol>
        </section>
    );
}
