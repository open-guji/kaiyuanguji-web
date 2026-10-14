'use client';

import type { FulltextError, FulltextHit, FulltextResponse } from '@/lib/fulltext/fulltext-client';
import { readerPath } from '@/lib/reader-route';
import { useSiteT } from '@/i18n/use-site-t';
import type { SiteT } from '@/i18n/translate';

/**
 * 全文搜索结果列表（GUJI-163 / F6 步 3）。纯展示：数据由 FulltextTab 取，这里不发请求。
 *
 * 安全：`snippet` 是唯一走 innerHTML 的字段，且先整体转义、再只放回 `<mark>`／`</mark>`；
 * 书名、章标签、查询词等其余字段一律文本节点。
 */

export function errorMessage(e: FulltextError, t: SiteT): string {
    switch (e.kind) {
        case 'bad_query': return t('bookIndex.fulltext.errBadQuery');
        case 'rate_limited': return e.retryAfterSec != null ? t('bookIndex.fulltext.errRateLimitedIn', { n: e.retryAfterSec }) : t('bookIndex.fulltext.errRateLimited');
        case 'timeout': return t('bookIndex.fulltext.errTimeout');
        case 'offline': return t('bookIndex.fulltext.errOffline');
        case 'unavailable':
        case 'bad_response':
        default: return t('bookIndex.fulltext.errUnavailable');
    }
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** 只放行 <mark>…</mark>；其余尖括号全部转义 */
export function safeSnippetHtml(snippet: string): string {
    return escapeHtml(snippet).replace(/&lt;mark&gt;/g, '<mark>').replace(/&lt;\/mark&gt;/g, '</mark>');
}

/** 阅读页定位链接：`?ft=<章>:<起>-<止>`（章内码点偏移，取首个命中）＋`ftq`（查询词，阅读页只当文本显示） */
export function hitHref(entry: string, hit: FulltextHit, q: string): string {
    const base = readerPath(entry, { chapter: hit.chapter });
    const first = hit.matches[0];
    if (!first) return base;
    return `${base}?ft=${encodeURIComponent(`${hit.chapter}:${first[0]}-${first[1]}`)}&ftq=${encodeURIComponent(q)}`;
}

interface Props {
    data?: FulltextResponse | null;
    error?: FulltextError | null;
    loading?: boolean;
    onLoadMore?: () => void;
}

export default function FulltextResults({ data, error, loading, onLoadMore }: Props) {
    const t = useSiteT();
    if (error) return <p role="alert">{errorMessage(error, t)}</p>;
    if (!data) return loading ? <p aria-busy="true">{t('bookIndex.fulltext.searching')}</p> : null;
    if (data.groups.length === 0) return <p>{t('bookIndex.fulltext.noResult', { q: data.q })}</p>;

    return (
        <div>
            <p>{t('bookIndex.fulltext.total', { n: data.total_hits })}{data.total_books_capped ? t('bookIndex.fulltext.booksCapped') : ''}</p>
            {(data.capped || data.truncated) && <p>{t('bookIndex.fulltext.capped')}</p>}
            {data.groups.map((g) => (
                <section key={g.entry}>
                    <h3>{g.title} <small>{t('bookIndex.fulltext.hitCount', { n: g.hit_count })}</small></h3>
                    <ul>
                        {g.hits.map((h, i) => (
                            <li key={`${h.chapter}-${h.passage[0]}-${i}`}>
                                <a href={hitHref(g.entry, h, data.q)}>
                                    <span>{h.label ?? h.chapter}</span>
                                </a>
                                {/* 唯一的 innerHTML：已由 safeSnippetHtml 转义，只含 <mark> */}
                                <p dangerouslySetInnerHTML={{ __html: safeSnippetHtml(h.snippet) }} />
                            </li>
                        ))}
                    </ul>
                </section>
            ))}
            {data.has_more && (
                <button type="button" onClick={onLoadMore} disabled={loading}>{t('bookIndex.fulltext.loadMore')}</button>
            )}
        </div>
    );
}
