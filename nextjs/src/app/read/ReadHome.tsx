'use client';

/**
 * 阅读首页的呈现（overview#267 第 16 项；首页分区 overview#308）。客户端组件，为的是用 useConvert：
 * 直出 HTML 与水合后同样是简体（数据原文是繁体）。全部是真链接，关掉 JS 也能点。
 *
 * - 首页：book-index-ui 的 ReadHomeView（样式随组件自带，走 --bim-* 令牌与 data-layout）。
 *   页首没有大小标题和导语（用户 10-01），只有「在可读书中搜索」框与统计；h1 只给读屏。
 * - 节点页、年代页：卡片列表＋分页。卡片上不写「整理本」「全文」，同一作品有几个本子标「N本」。
 * 本页自己的样式一律行内写：Tailwind 会扫描全部源文件生成全站 CSS，这里用新类名会让正式站（静态导出，看不到本页）
 * 的 CSS 与引用哈希跟着变。
 */
import Link from 'next/link';
import { ReadHomeView, useConvert } from 'book-index-ui';
import type { ReadHomeLinks } from 'book-index-ui';
import LayoutWrapper from '@/components/layout/LayoutWrapper';
import BimLocaleProvider from '@/components/common/BimLocaleProvider';
import {
    READ_PERIODS, readCardHref, readHomeHref, readPeriodHref,
    type CatalogNode, type ReadCard, type ReadSections, type ResolvedPeriod,
} from './read-route';

const S = {
    wrap: { maxWidth: '1440px', margin: '0 auto', padding: '24px clamp(16px, 2.4vw, 32px) 0', color: 'var(--color-ink)' },
    listWrap: { maxWidth: '64rem', margin: '0 auto', padding: '32px 20px 64px', color: 'var(--color-ink)' },
    sr: { position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0 } as const,
    h1: { fontSize: '1.5rem', fontWeight: 700, margin: '4px 0 16px' },
    note: { color: 'var(--bim-aux-fg)', fontSize: '0.875rem', margin: '0 0 12px' },
    /** 面包屑里的链接夹在文字中间，不能只靠颜色区分（axe link-in-text-block） */
    crumb: { textDecoration: 'underline', textUnderlineOffset: 3 } as const,
    chips: { display: 'flex', flexWrap: 'wrap', gap: 8, listStyle: 'none', padding: 0, margin: 0 } as const,
    chip: {
        display: 'inline-block', padding: '4px 12px', borderRadius: 999, fontSize: '0.875rem',
        border: '1px solid var(--color-border)', background: 'var(--color-raise)', color: 'var(--color-ink)', textDecoration: 'none',
    } as const,
    chipOn: { background: 'var(--color-zhu)', borderColor: 'var(--color-zhu)', color: '#fff' } as const,
    grid: {
        /* 列宽在 globals.css 的 .read-cards：手机端要改成两列，内联样式进不了媒体查询 */
        display: 'grid', gap: 12, listStyle: 'none', padding: 0, margin: '20px 0 0',
    } as const,
    card: {
        /* 版式判准（overview#325 第 14 条）：直角；框线走令牌——疏朗 1px 透明（不画框、盒子不跳），界栏 1px 实线 */
        display: 'block', padding: '12px 14px', border: 'var(--bim-fr-card-bd)',
        background: 'var(--color-raise)', textDecoration: 'none', color: 'var(--color-ink)',
    } as const,
    cardTitle: { fontWeight: 600 },
    edition: { color: 'var(--color-ink-2)', fontSize: '0.8125rem', marginTop: 2 },
    meta: { color: 'var(--bim-aux-fg)', fontSize: '0.8125rem', marginTop: 2 },
    pager: { display: 'flex', gap: 16, alignItems: 'center', marginTop: 24, fontSize: '0.9375rem' },
    sub: { marginTop: 12 },
    empty: { padding: '48px 0', color: 'var(--color-ink-2)' },
    search: { display: 'flex', alignItems: 'stretch', maxWidth: 760, margin: '0 0 12px', border: '1px solid var(--bim-rule-dashed)', background: 'var(--bim-card-bg)' } as const,
    searchInput: { flex: 1, minWidth: 0, padding: '12px 14px', border: 0, background: 'none', font: 'inherit', fontSize: 15, color: 'var(--bim-ink)' } as const,
    searchBtn: { padding: '0 22px', border: 0, background: 'var(--bim-accent)', color: 'var(--bim-page-bg)', font: 'inherit', fontSize: 15, letterSpacing: '0.2em', cursor: 'pointer' } as const,
};

const LINKS: Partial<ReadHomeLinks> = {
    read: (id) => readCardHref({ id }),
    node: (id) => readHomeHref(id),
    period: (key) => readPeriodHref(key),
    work: (id) => `/item/${encodeURIComponent(id)}`,
};

/** 页首：「在可读书中搜索」——搜索页还没有「站内可读」筛选，先跳普通搜索 */
function SearchBox() {
    const { convert } = useConvert();
    return (
        <form role="search" action="/book-index" method="get" style={S.search} data-read-search>
            <label htmlFor="read-q" style={S.sr}>{convert('在可讀書中搜索')}</label>
            <input id="read-q" name="q" type="search" placeholder={convert('書名、作者，如 文選、蘇軾')} style={S.searchInput} />
            <button type="submit" style={S.searchBtn}>{convert('搜索')}</button>
        </form>
    );
}

function Cards({ cards }: { cards: ReadCard[] }) {
    const { convert } = useConvert();
    return (
        <ul className="read-cards" style={S.grid} data-read-list>
            {cards.map((c) => (
                <li key={c.id}>
                    <Link href={readCardHref(c)} style={S.card} data-read-card={c.id}>
                        <div style={S.cardTitle}>{convert(c.title)}</div>
                        {c.edition && <div style={S.edition}>{convert(c.edition)}</div>}
                        <div style={S.meta}>
                            {[
                                c.authors?.[0] && convert([c.authors[0].dynasty, c.authors[0].name].filter(Boolean).join(' ')),
                                c.juan && (typeof c.juan === 'number' ? `${c.juan}卷` : convert(c.juan)),
                                c.text_count && c.text_count > 1 ? `${c.text_count}本` : null,
                            ].filter(Boolean).join(' · ')}
                        </div>
                    </Link>
                </li>
            ))}
        </ul>
    );
}

function Pager({ page, pageCount, href }: { page: number; pageCount: number; href: (p: number) => string }) {
    if (pageCount <= 1) return null;
    return (
        <nav style={S.pager} aria-label="分页">
            {page > 1 && <Link href={href(page - 1)} rel="prev">上一页</Link>}
            <span>第 {page} / {pageCount} 页</span>
            {page < pageCount && <Link href={href(page + 1)} rel="next">下一页</Link>}
        </nav>
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
    /** 首页分区；null＝这一版数据还没有阅读索引 */
    sections?: ReadSections | null;
    /** 节点页：分类树（四部切换） */
    tree?: CatalogNode[];
    /** 节点页：从根到当前节点的路径、页码、本页作品 */
    current?: { path: CatalogNode[]; page: number; pageCount: number; cards: ReadCard[] };
    /** 年代页；periods＝有条目的年代段（切换签） */
    period?: ResolvedPeriod & { cards: ReadCard[]; periods: { key: string; label: string }[] };
}

function NodePage({ tree, current }: { tree: CatalogNode[]; current: NonNullable<ReadHomeProps['current']> }) {
    const { convert } = useConvert();
    const node = current.path[current.path.length - 1];
    const top = current.path[0];
    const children = node.children ?? [];
    return (
        <div style={S.listWrap}>
            <p style={S.note}>
                <Link href="/read" style={S.crumb}>阅读</Link>
                {current.path.map((n) => (
                    <span key={n.id}>
                        {' › '}
                        <Link href={readHomeHref(n.id)} style={S.crumb}>{convert(n.label)}</Link>
                    </span>
                ))}
                ，共 {node.count} 部
            </p>
            <h1 style={S.h1}>{convert(current.path.map((n) => n.label).join('·'))}</h1>
            <NodeChips nodes={tree} currentId={top.id} label="四部分类" />
            {children.length > 0 && (
                <div style={S.sub}>
                    <NodeChips nodes={children} label={`${node.label}下的分类`} />
                </div>
            )}
            <Cards cards={current.cards} />
            <Pager page={current.page} pageCount={current.pageCount} href={(p) => readHomeHref(node.id, p)} />
        </div>
    );
}

function PeriodPage({ period }: { period: NonNullable<ReadHomeProps['period']> }) {
    const { convert } = useConvert();
    return (
        <div style={S.listWrap}>
            <p style={S.note}>
                <Link href="/read" style={S.crumb}>阅读</Link>{' › '}按年代{' › '}{convert(period.label)}，共 {period.count} 部
            </p>
            <h1 style={S.h1}>{convert(period.label)}</h1>
            <ul style={S.chips} aria-label="年代">
                {period.periods.map((p) => (
                    <li key={p.key}>
                        <Link
                            href={readPeriodHref(p.key)}
                            style={{ ...S.chip, ...(p.key === period.key ? S.chipOn : null) }}
                            aria-current={p.key === period.key ? 'true' : undefined}
                        >
                            {convert(p.label || READ_PERIODS.find((x) => x.key === p.key)?.label || p.key)}
                        </Link>
                    </li>
                ))}
            </ul>
            <Cards cards={period.cards} />
            <Pager page={period.page} pageCount={period.pageCount} href={(p) => readPeriodHref(period.key, p)} />
        </div>
    );
}

function Body({ sections, tree, current, period }: ReadHomeProps) {
    if (period) return <PeriodPage period={period} />;
    if (current && tree) return <NodePage tree={tree} current={current} />;
    return (
        <div style={S.wrap}>
            <h1 style={S.sr}>阅读</h1>
            {sections
                ? <ReadHomeView sections={sections} links={LINKS} head={<SearchBox />} />
                : <p style={S.empty}>阅读列表正在准备中，请稍后再来。</p>}
        </div>
    );
}

export default function ReadHome(props: ReadHomeProps) {
    return (
        <BimLocaleProvider>
            <LayoutWrapper>
                <Body {...props} />
            </LayoutWrapper>
        </BimLocaleProvider>
    );
}
