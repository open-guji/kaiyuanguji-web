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
import { readCardHref, readHomeHref, type CatalogNode, type ReadCard, type ReadFeatured } from './read-route';

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
    edition: { color: 'var(--color-ink-2)', fontSize: '0.8125rem', marginTop: 2 },
    meta: { color: 'var(--color-ink-3)', fontSize: '0.8125rem', marginTop: 2 },
    pager: { display: 'flex', gap: 16, alignItems: 'center', marginTop: 24, fontSize: '0.9375rem' },
    sub: { marginTop: 12 },
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
                        {c.edition && <div style={S.edition}>{convert(c.edition)}</div>}
                        <div style={S.meta}>
                            {[c.authors?.[0] && convert([c.authors[0].dynasty, c.authors[0].name].filter(Boolean).join(' ')), c.juan && (typeof c.juan === 'number' ? `${c.juan}卷` : convert(c.juan)), c.collated && '整理本']
                                .filter(Boolean)
                                .join(' · ')}
                        </div>
                    </Link>
                </li>
            ))}
        </ul>
    );
}

function NodeChips({ nodes, currentId, label }: { nodes: CatalogNode[]; currentId?: string; label: string }) {
    const { convert } = useConvert();
    return (
        <ul style={S.chips} aria-label={label}>
            {nodes.map((n) => (
                <li key={n.id}>
                    <Link
                        href={readHomeHref(n.id)}
                        style={{ ...S.chip, ...(n.id === currentId ? S.chipOn : null) }}
                        aria-current={n.id === currentId ? 'true' : undefined}
                    >
                        {convert(n.label)} {n.count}
                    </Link>
                </li>
            ))}
        </ul>
    );
}

export interface ReadHomeProps {
    /** null＝这一版数据还没有阅读索引 */
    tree: CatalogNode[] | null;
    /** 首页：整理本与书本 */
    featured?: ReadFeatured;
    /** 节点页：从根到当前节点的路径、页码、本页作品 */
    current?: { path: CatalogNode[]; page: number; pageCount: number; cards: ReadCard[] };
}

function Body({ tree, featured, current }: ReadHomeProps) {
    const { convert } = useConvert();
    if (!tree) return <p style={S.empty}>阅读列表正在准备中，请稍后再来。</p>;
    if (current) {
        const node = current.path[current.path.length - 1];
        const top = current.path[0];
        const children = node.children ?? [];
        return (
            <>
                <p style={S.note}>
                    <Link href="/read">阅读</Link>
                    {current.path.map((n) => (
                        <span key={n.id}>
                            {' › '}
                            <Link href={readHomeHref(n.id)}>{convert(n.label)}</Link>
                        </span>
                    ))}
                    ，共 {node.count} 部
                </p>
                <NodeChips nodes={tree} currentId={top.id} label="四部分类" />
                {children.length > 0 && (
                    <div style={S.sub}>
                        <NodeChips nodes={children} label={`${node.label}下的分类`} />
                    </div>
                )}
                <h2 style={S.h2}>{convert(current.path.map((n) => n.label).join('·'))}</h2>
                <Cards cards={current.cards} />
                {current.pageCount > 1 && (
                    <nav style={S.pager} aria-label="分页">
                        {current.page > 1 && <Link href={readHomeHref(node.id, current.page - 1)} rel="prev">上一页</Link>}
                        <span>第 {current.page} / {current.pageCount} 页</span>
                        {current.page < current.pageCount && <Link href={readHomeHref(node.id, current.page + 1)} rel="next">下一页</Link>}
                    </nav>
                )}
            </>
        );
    }
    return (
        <>
            <h2 style={S.h2}>整理本（{featured?.collated.length ?? 0} 部）</h2>
            <p style={S.note}>人工校对过的整理本，逐卷阅读。</p>
            <Cards cards={featured?.collated ?? []} />
            <h2 style={S.h2}>书本全文（{featured?.books.length ?? 0} 部）</h2>
            <Cards cards={featured?.books ?? []} />
            <h2 style={S.h2}>全文作品（按四部分类）</h2>
            <p style={S.note}>与古籍总目同一套分类；选一部，浏览其中有整理本或全文的作品，有整理本的排在前面。</p>
            <NodeChips nodes={tree} label="四部分类" />
        </>
    );
}

export default function ReadHome(props: ReadHomeProps) {
    return (
        <LocaleProvider>
            <LayoutWrapper>
                <div style={S.wrap}>
                    <h1 style={S.h1}>阅读</h1>
                    <p style={S.lead}>站上所有有整理本或全文的古籍，点开即可阅读。</p>
                    <Body {...props} />
                </div>
            </LayoutWrapper>
        </LocaleProvider>
    );
}
