'use client';

import type { FulltextError, FulltextHit, FulltextResponse } from '@/lib/fulltext/fulltext-client';
import { readerPath } from '@/lib/reader-route';

/**
 * 全文搜索结果列表（GUJI-163 / F6 步 3）。纯展示：数据由 FulltextTab 取，这里不发请求。
 *
 * 安全：`snippet` 是唯一走 innerHTML 的字段，且先整体转义、再只放回 `<mark>`／`</mark>`；
 * 书名、章标签、查询词等其余字段一律文本节点。
 */

export function errorMessage(e: FulltextError): string {
    switch (e.kind) {
        case 'bad_query': return '请换个关键词再试（至少一个汉字，不要太长）。';
        case 'rate_limited': return e.retryAfterSec != null ? `搜索太频繁，请 ${e.retryAfterSec} 秒后再试。` : '搜索太频繁，请稍后再试。';
        case 'timeout': return '全文搜索超时，请稍后再试。';
        case 'offline': return '网络不通，无法使用全文搜索。';
        case 'unavailable':
        case 'bad_response':
        default: return '全文搜索暂不可用。';
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
    if (error) return <p role="alert">{errorMessage(error)}</p>;
    if (!data) return loading ? <p aria-busy="true">搜索中…</p> : null;
    if (data.groups.length === 0) return <p>没有找到包含“{data.q}”的正文。</p>;

    return (
        <div>
            <p>共 {data.total_hits} 处命中{data.total_books_capped ? '（书目数已截断）' : ''}</p>
            {(data.capped || data.truncated) && <p>结果已截断，请加长关键词缩小范围。</p>}
            {data.groups.map((g) => (
                <section key={g.entry}>
                    <h3>{g.title} <small>{g.hit_count} 处</small></h3>
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
                <button type="button" onClick={onLoadMore} disabled={loading}>加载更多</button>
            )}
        </div>
    );
}
