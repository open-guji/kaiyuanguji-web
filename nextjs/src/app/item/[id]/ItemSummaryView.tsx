'use client';

import { useConvert } from 'book-index-ui';
import LayoutWrapper from '@/components/layout/LayoutWrapper';
import type { ItemSummary } from '@/lib/server/item-summary';

// 样式一律行内写：Tailwind 会扫描全部源文件生成全站 CSS，这里若用到新类名，
// 正式站（静态导出，看不到本页）的 CSS 与所有页面的引用哈希也会跟着变。
const S = {
    article: { maxWidth: '48rem', margin: '0 auto', padding: '40px 20px', lineHeight: 1.75, color: '#44403c' },
    h1: { fontSize: '1.5rem', fontWeight: 700, color: '#1c1917', marginBottom: 8 },
    edition: { marginLeft: 8, fontSize: '1rem', fontWeight: 400, color: '#78716c' },
    authors: { color: '#57534e', marginBottom: 8 },
    measure: { fontSize: '0.875rem', color: '#78716c', marginBottom: 16 },
    desc: { whiteSpace: 'pre-wrap' as const, marginBottom: 24 },
    loading: { fontSize: '0.875rem', color: '#a8a29e' },
};

/**
 * 条目页服务端首屏摘要（书名／作者／卷数／简介），是 ItemDetailClient 里 Suspense 的 fallback：
 * 详情组件读 useSearchParams，服务端渲染时退到这里，所以直出 HTML 里只有它，水合后才换成完整详情。
 *
 * 客户端组件，为的是能用 useConvert：包在 ItemDetailClient 的 LocaleProvider 里，
 * 直出的 HTML 与水合后的详情页同样是简体（overview#267 QA 回归 P2；此前这里出的是数据原文的繁体，
 * 关掉 JS 看到的标题、作者、提要都是繁体）。book-index-ui 0.11.0 起 LocaleProvider 首帧同步转换。
 */
export default function ItemSummaryView({ s, source, version }: { s: ItemSummary; source: string; version: string }) {
    const { convert } = useConvert();
    return (
        <LayoutWrapper hideFooter>
            {/* data-ssr-source／data-ssr-version：取数走的哪条路、哪一版数据；排查与发版后实测（W2-3）用 */}
            <article data-ssr-item={s.id} data-ssr-source={source} data-ssr-version={version} style={S.article}>
                <h1 style={S.h1}>
                    {convert(s.title)}
                    {s.edition && <span style={S.edition}>{convert(s.edition)}</span>}
                </h1>
                {s.authorLine && <p style={S.authors}>{convert(s.authorLine)}</p>}
                {s.measure && <p style={S.measure}>{convert(s.measure)}</p>}
                {s.description && <p style={S.desc}>{convert(s.description)}</p>}
                <p style={S.loading}>加载中...</p>
            </article>
        </LayoutWrapper>
    );
}
