'use client';

/**
 * 阅读首页的呈现（overview#267 第 16 项）。客户端组件，为的是用 useConvert：
 * 直出 HTML 与水合后同样是简体（数据原文是繁体）。全部是真链接，关掉 JS 也能点。
 * 样式一律行内写：Tailwind 会扫描全部源文件生成全站 CSS，这里用新类名会让正式站（静态导出，看不到本页）
 * 的 CSS 与引用哈希跟着变。
 */
import Link from 'next/link';
import { LocaleProvider, useConvert } from 'book-index-ui';
import LayoutWrapper from '@/components/layout/LayoutWrapper';
import {
    isTruncated,
    readCardHref,
    readHomeHref,
    readPageCount,
    sortDynasties,
    READ_MAX_HITS,
    type ReadCard,
} from './read-route';

const S = {
    wrap: { maxWidth: '64rem', margin: '0 auto', padding: '40px 20px 64px', color: 'var(--color-ink)' },
    h1: { fontSize: '1.75rem', fontWeight: 700, margin: 0 },
    lead: { color: 'var(--color-ink-2)', margin: '8px 0 28px', lineHeight: 1.7 },
    h2: { fontSize: '1.15rem', fontWeight: 700, margin: '32px 0 12px' },
    note: { color: 'var(--color-ink-3)', fontSize: '0.875rem', margin: '4px 0 12px' },
    chips: { display: 'flex', flexWrap: 'wrap', gap: 8, listStyle: 'none', padding: 0, margin: 0 } as const,
    chip: {
        display: 'inline-block', padding: '4px 12px', borderRadius: 999, fontSize: '0.875rem',
        border: '1px solid var(--color-border)', background: 'var(--color-raise)', color: 'var(--color-ink)', textDecoration: 'none',
    } as const,
    chipOn: { background: 'var(--color-zhu)', borderColor: 'var(--color-zhu)', color: '#fff' } as const,
    grid: {
        display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12, listStyle: 'none', padding: 0, margin: 0,
    } as const,
    card: {
        display: 'block', padding: '12px 14px', border: '1px solid var(--color-border)', borderRadius: 8,
        background: 'var(--color-raise)', textDecoration: 'none', color: 'var(--color-ink)',
    } as const,
    cardTitle: { fontWeight: 600 },
    meta: { color: 'var(--color-ink-3)', fontSize: '0.8125rem', marginTop: 2 },
    pager: { display: 'flex', gap: 16, alignItems: 'center', marginTop: 24, fontSize: '0.9375rem' },
    switch: { margin: '4px 0 0' },
    switchSummary: { cursor: 'pointer', color: 'var(--color-ink-2)', fontSize: '0.875rem', margin: '0 0 10px' },
    empty: { padding: '48px 0', color: 'var(--color-ink-2)' },
};

function Cards({ cards }: { cards: ReadCard[] }) {
    const { convert } = useConvert();
    return (
        <ul style={S.grid} data-read-list>
            {cards.map((c) => (
                <li key={c.id}>
                    <Link href={readCardHref(c)} style={S.card} data-read-card={c.id}>
                        <div style={S.cardTitle}>{convert(c.title)}</div>
                        <div style={S.meta}>
                            {[c.dynasty && convert(c.dynasty), c.author && convert(c.author), c.juanCount && `${c.juanCount}卷`, c.hasCollated && '整理本']
                                .filter(Boolean)
                                .join(' · ')}
                        </div>
                    </Link>
                </li>
            ))}
        </ul>
    );
}

function DynastyChips({ facet, current }: { facet: Record<string, number>; current?: string }) {
    const { convert } = useConvert();
    return (
        <ul style={S.chips} aria-label="按朝代">
            {sortDynasties(facet).map((d) => (
                <li key={d.name}>
                    <Link
                        href={readHomeHref(d.name)}
                        style={{ ...S.chip, ...(d.name === current ? S.chipOn : null) }}
                        aria-current={d.name === current ? 'true' : undefined}
                    >
                        {convert(d.name)} {d.count}
                    </Link>
                </li>
            ))}
        </ul>
    );
}

export interface ReadHomeProps {
    /** null＝没配 Meili，无法取数 */
    data: null | {
        facet: Record<string, number>;
        dynasty?: string;
        page: number;
        /** 首页（无朝代）：整理本与书本；朝代页：本页作品 */
        collated?: ReadCard[];
        books?: ReadCard[];
        works?: ReadCard[];
    };
}

function Body({ data }: ReadHomeProps) {
    const { convert } = useConvert();
    if (!data) return <p style={S.empty}>阅读列表暂时无法加载，请稍后再试。</p>;
    const total = data.dynasty ? data.facet[data.dynasty] ?? 0 : 0;
    const pageCount = readPageCount(total);
    return (
        <>
            {data.dynasty ? (
                <>
                    <p style={S.note}>
                        <Link href="/read">阅读</Link> › {convert(data.dynasty)}，共 {total} 部
                    </p>
                    <details style={S.switch}>
                        <summary style={S.switchSummary}>换朝代</summary>
                        <DynastyChips facet={data.facet} current={data.dynasty} />
                    </details>
                    <h2 style={S.h2}>{convert(data.dynasty)}代作品</h2>
                    <Cards cards={data.works ?? []} />
                    {pageCount > 1 && (
                        <nav style={S.pager} aria-label="分页">
                            {data.page > 1 && <Link href={readHomeHref(data.dynasty, data.page - 1)} rel="prev">上一页</Link>}
                            <span>第 {data.page} / {pageCount} 页</span>
                            {data.page < pageCount && <Link href={readHomeHref(data.dynasty, data.page + 1)} rel="next">下一页</Link>}
                        </nav>
                    )}
                    {isTruncated(total) && (
                        <p style={S.note}>此朝代共 {total} 部，这里只能翻到前 {READ_MAX_HITS} 部，其余请用「古籍元数据」搜索。</p>
                    )}
                </>
            ) : (
                <>
                    <h2 style={S.h2}>整理本（{data.collated?.length ?? 0} 部）</h2>
                    <p style={S.note}>人工校对过的整理本，逐卷阅读。</p>
                    <Cards cards={data.collated ?? []} />
                    <h2 style={S.h2}>书本全文（{data.books?.length ?? 0} 部）</h2>
                    <Cards cards={data.books ?? []} />
                    <h2 style={S.h2}>全文作品（按朝代）</h2>
                    <p style={S.note}>选一个朝代，浏览该朝代有全文的作品。</p>
                    <DynastyChips facet={data.facet} />
                </>
            )}
        </>
    );
}

export default function ReadHome({ data }: ReadHomeProps) {
    return (
        <LocaleProvider>
            <LayoutWrapper>
                <div style={S.wrap}>
                    <h1 style={S.h1}>阅读</h1>
                    <p style={S.lead}>站上所有有整理本或全文的古籍，点开即可阅读。</p>
                    <Body data={data} />
                </div>
            </LayoutWrapper>
        </LocaleProvider>
    );
}
