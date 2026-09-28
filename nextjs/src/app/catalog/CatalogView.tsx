/**
 * 古籍总目的最简渲染（N4b 过渡件）。
 *
 * N4a（overview#218）的 CatalogPage／CatalogTree／WorkCardGrid 随 book-index-ui 0.11.0 发布；
 * 在那之前网站先按同一份数据契约自己渲染一版，发版后整体换成正式组件，本文件删掉。
 * props 与契约同名（tree／selectedId／page／pageCount／works），翻页与选节点在这里是真链接
 * （服务端渲染，不需要客户端脚本），换组件时由宿主把 onSelect／onPage 接到路由上。
 *
 * 样式行内加一段 <style>：Tailwind 会扫描全部源文件生成全站 CSS，这里若用新类名，
 * 正式站（静态导出，看不到本页）的 CSS 也会跟着变（同 item/[id]/page.ssr.tsx 的做法）。
 */
import type { CatalogNode, CatalogWorkCard } from './catalog-route';

export interface CatalogViewProps {
    tree: CatalogNode[];
    selectedId: string;
    /** 从根到当前节点 */
    path: CatalogNode[];
    page: number;
    pageCount: number;
    works: CatalogWorkCard[];
    nodeHref: (id: string) => string;
    pageHref: (page: number) => string;
    workLink: (id: string) => string;
}

const CSS = `
.og-cat{max-width:var(--shell-max);margin:0 auto;padding:32px var(--shell-gutter) 56px;display:grid;grid-template-columns:260px minmax(0,1fr);gap:40px;color:var(--color-ink)}
.og-cat-h1{font-size:var(--fs-xl);font-weight:var(--fw-bold);margin:0 0 4px}
.og-cat-sub{color:var(--color-ink-2);font-size:var(--fs-sm);margin:0 0 24px}
.og-cat-aside{align-self:start;position:sticky;top:calc(var(--nav-h) + 16px);background:var(--color-tint);border-radius:var(--radius-card);padding:12px 8px;max-height:calc(100vh - var(--nav-h) - 32px);overflow:auto}
.og-cat-drawer{display:none}
.og-cat-tree,.og-cat-tree ul{list-style:none;margin:0;padding:0}
.og-cat-tree ul{padding-left:14px}
.og-cat-tree a{display:flex;justify-content:space-between;gap:8px;align-items:center;min-height:44px;padding:0 10px;border-radius:var(--radius-pill);color:var(--color-ink);text-decoration:none;font-size:var(--fs-base)}
.og-cat-tree a:hover{background:var(--color-tint-2)}
.og-cat-tree a[aria-current="page"]{background:var(--color-zhu-tint);color:var(--color-zhu-deep);font-weight:var(--fw-medium)}
.og-cat-tree .n{color:var(--color-ink-2);font-size:var(--fs-sm);font-variant-numeric:tabular-nums}
.og-cat-grid{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}
.og-cat-card{display:flex;flex-direction:column;gap:6px;height:100%;padding:16px;background:var(--color-raise);border-radius:var(--radius-card);box-shadow:var(--shadow-soft);color:var(--color-ink);text-decoration:none}
.og-cat-card:hover .t{color:var(--color-zhu)}
.og-cat-card .t{font-size:var(--fs-md);font-weight:var(--fw-bold);line-height:1.4}
.og-cat-card .j{font-size:var(--fs-sm);font-weight:var(--fw-regular);color:var(--color-ink-2);margin-left:6px}
.og-cat-card .a{font-size:var(--fs-sm);color:var(--color-ink-2)}
.og-cat-card .d{font-size:var(--fs-xs);margin-left:2px}
.og-cat-card .s{font-size:var(--fs-sm);line-height:1.7;color:var(--color-ink-2);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;margin:0}
.og-cat-card .c{margin-top:auto;font-size:var(--fs-xs);color:var(--color-ink-2)}
.og-cat-pager{display:flex;flex-wrap:wrap;gap:6px;align-items:center;justify-content:center;margin-top:32px}
.og-cat-pager a,.og-cat-pager span{display:inline-flex;align-items:center;justify-content:center;min-width:44px;min-height:44px;padding:0 12px;border-radius:var(--radius-pill);color:var(--color-ink);text-decoration:none;font-variant-numeric:tabular-nums}
.og-cat-pager a:hover{background:var(--color-tint-2)}
.og-cat-pager [aria-current="page"]{background:var(--color-zhu);color:#fff}
.og-cat-pager .off{color:var(--color-ink-2)}
@media (max-width:1199px){.og-cat-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:899px){
.og-cat{grid-template-columns:minmax(0,1fr);gap:16px;padding-top:20px}
.og-cat-aside{display:none}
.og-cat-drawer{display:block;background:var(--color-tint);border-radius:var(--radius-card)}
.og-cat-drawer>summary{min-height:44px;display:flex;align-items:center;padding:0 16px;cursor:pointer;font-weight:var(--fw-medium)}
.og-cat-drawer>.og-cat-tree{padding:0 8px 8px}
}
@media (max-width:599px){.og-cat-grid{grid-template-columns:minmax(0,1fr)}}
`;

function Tree({ nodes, openIds, selectedId, nodeHref }: {
    nodes: CatalogNode[];
    openIds: Set<string>;
    selectedId: string;
    nodeHref: (id: string) => string;
}) {
    return (
        <ul>
            {nodes.map((n) => (
                <li key={n.id}>
                    <a href={nodeHref(n.id)} aria-current={n.id === selectedId ? 'page' : undefined}>
                        <span>{n.label}</span>
                        <span className="n">{n.count}</span>
                    </a>
                    {n.children && openIds.has(n.id) && (
                        <Tree nodes={n.children} openIds={openIds} selectedId={selectedId} nodeHref={nodeHref} />
                    )}
                </li>
            ))}
        </ul>
    );
}

function Card({ w, href }: { w: CatalogWorkCard; href: string }) {
    return (
        <a className="og-cat-card" href={href}>
            <span className="t">
                {w.title}
                {w.juan ? <span className="j">{w.juan}卷</span> : null}
            </span>
            {w.authors && w.authors.length > 0 && (
                <span className="a">
                    {w.authors.map((a, i) => (
                        <span key={i}>
                            {i > 0 ? '、' : ''}
                            {a.name}
                            {a.dynasty ? <span className="d">（{a.dynasty}）</span> : null}
                        </span>
                    ))}
                </span>
            )}
            {w.summary && <p className="s">{w.summary}</p>}
            {w.classification && w.classification.length > 0 && (
                <span className="c">{w.classification.join('·')}</span>
            )}
        </a>
    );
}

/** 页码：首尾两页＋当前页前后各两页，中间省略 */
export function pageList(page: number, pageCount: number): (number | null)[] {
    const want = new Set<number>([1, pageCount]);
    for (let p = page - 2; p <= page + 2; p++) if (p >= 1 && p <= pageCount) want.add(p);
    const sorted = [...want].sort((a, b) => a - b);
    const out: (number | null)[] = [];
    for (let i = 0; i < sorted.length; i++) {
        if (i > 0 && sorted[i] - sorted[i - 1] > 1) out.push(null);
        out.push(sorted[i]);
    }
    return out;
}

function Pager({ page, pageCount, pageHref }: { page: number; pageCount: number; pageHref: (p: number) => string }) {
    if (pageCount <= 1) return null;
    return (
        <nav className="og-cat-pager" aria-label="分页">
            {page > 1 ? <a href={pageHref(page - 1)} rel="prev">上一页</a> : <span className="off" aria-disabled="true">上一页</span>}
            {pageList(page, pageCount).map((p, i) =>
                p === null
                    ? <span key={`gap${i}`} className="off" aria-hidden="true">…</span>
                    : <a key={p} href={pageHref(p)} aria-current={p === page ? 'page' : undefined} aria-label={`第${p}页`}>{p}</a>,
            )}
            {page < pageCount ? <a href={pageHref(page + 1)} rel="next">下一页</a> : <span className="off" aria-disabled="true">下一页</span>}
        </nav>
    );
}

export default function CatalogView(p: CatalogViewProps) {
    const openIds = new Set(p.path.map((n) => n.id));
    const node = p.path[p.path.length - 1];
    const trail = p.path.map((n) => n.label).join(' › ');
    const tree = <Tree nodes={p.tree} openIds={openIds} selectedId={p.selectedId} nodeHref={p.nodeHref} />;
    return (
        <div className="og-cat" data-catalog-node={p.selectedId} data-catalog-page={p.page}>
            <style>{CSS}</style>
            <aside className="og-cat-aside" aria-label="分类">
                <nav className="og-cat-tree">{tree}</nav>
            </aside>
            <section>
                <details className="og-cat-drawer">
                    <summary>分类：{trail}</summary>
                    <nav className="og-cat-tree" aria-label="分类">{tree}</nav>
                </details>
                <h1 className="og-cat-h1">{trail}</h1>
                <p className="og-cat-sub">
                    共 {node.count} 部{p.pageCount > 1 ? `，第 ${p.page}／${p.pageCount} 页` : ''}
                </p>
                <ul className="og-cat-grid">
                    {p.works.map((w) => (
                        <li key={w.id}>
                            <Card w={w} href={p.workLink(w.id)} />
                        </li>
                    ))}
                </ul>
                <Pager page={p.page} pageCount={p.pageCount} pageHref={p.pageHref} />
            </section>
        </div>
    );
}
