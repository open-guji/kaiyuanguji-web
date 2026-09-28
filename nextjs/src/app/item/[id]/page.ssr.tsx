// W2-1（31 卡 §A）：条目页 /item/<id> 函数按请求服务端渲染。
//
// 文件名带 .ssr：只有全栈构建（KYG_RENDER_MODE=fullstack，测试站）才把它当页面
// （next.config.ts 的 pageExtensions）；正式站静态导出看不到它——动态路由在
// output: 'export' 下没有 generateStaticParams 会直接构建失败，且正式站产物须与改前一致。
//
// W2-1：服务端取数＋首屏摘要（书名／作者／卷数／简介）直接进 HTML，客户端详情组件照旧挂载。
// W2-2：头部按 31 卡 §A.5 字段表出（title／description／canonical／OpenGraph／JSON-LD）；
//   被并条目 308 到目标页；其余查不到的 id 真 404（noindex）。
// PH：查不到的草稿 id 查 h1 升格对照表分片，升格了就一跳 308 到正式 id；对照表确定
//   没有它就 404；查不了（旧 root、h1 故障）才照旧 307 回 /book-index 由客户端查表。/book-index?id= → /item/ 的 308 在 middleware.ssr.ts。
// 按改动清缓存与 sitemap 归 W2-3。
import type { Metadata } from 'next';
import { notFound, permanentRedirect, redirect } from 'next/navigation';
import LayoutWrapper from '@/components/layout/LayoutWrapper';
import { SITE_NAME, SITE_URL } from '@/lib/constants';
import { parseItemId } from '@/lib/item-id';
import { getItemServer, getPromotionServer } from '@/lib/server/item-data';
import { summarizeItem, type ItemSummary } from '@/lib/server/item-summary';
import { buildItemSeo, jsonLdScript, mergedTarget, type ItemSeo } from '@/lib/server/item-seo';
import ItemDetailClient from './ItemDetailClient';

// 页面缓存：CDN 按 s-maxage 缓存（EdgeOne 上 Next 自己的 ISR 缓存不持久，25 卡）。
// W2-3 做完「发版按改动清缓存」后再放长到 30 天（31 卡 §A.6）；在那之前取 1 小时，
// 数据发布后测试站最多滞后 1 小时。
export const revalidate = 3600;
export const dynamicParams = true;

// 构建时一条都不预渲染（31 卡 §A.2：每页 10 个文件，全量上不了 EdgeOne）
export async function generateStaticParams(): Promise<{ id: string }[]> {
    return [];
}

type Props = { params: Promise<{ id: string }> };

type Loaded = ItemSummary & { source: 'h1' | 'current'; version: string; seo: ItemSeo };

/**
 * 取条目并处理跳转。generateMetadata 与页面各调一次，取数有进程内缓存，不会重复回源。
 * 返回 null ＝ 真 404。
 */
async function load(id: string): Promise<Loaded | null> {
    const hit = await getItemServer(id);
    if (!hit) {
        if (parseItemId(id)?.status === 'draft') {
            // 草稿 id 多半已升格：查 h1 里对应的一片对照表（31 卡 §A.6 第 5 条）
            const p = await getPromotionServer(id);
            if (p.status === 'promoted') permanentRedirect(`/item/${p.to}`);
            // 查不了：临时（307）跳回 /book-index，由客户端查表；middleware 不改写草稿 id，不会绕回来
            if (p.status === 'unknown') redirect(`/book-index?id=${id}`);
        }
        return null;
    }
    const target = mergedTarget(hit.entry, id);
    if (target) permanentRedirect(`/item/${target}`);
    return { ...summarizeItem(hit.entry, id), source: hit.source, version: hit.version, seo: buildItemSeo(hit.entry, id, SITE_URL) };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
    const { id } = await params;
    const s = await load(id);
    if (!s) return { title: '未找到条目', robots: { index: false, follow: false } };
    const { seo } = s;
    // openGraph／twitter 是整块覆盖 layout 的，不是逐字段合并：siteName、locale、图片要在这里重新带上，
    // 否则条目页的分享卡片没有站名和图，twitter 卡片还停在全站默认文案
    const ogTitle = `${seo.title} - ${SITE_NAME}`;
    return {
        title: seo.title,
        description: seo.description,
        alternates: { canonical: seo.canonicalPath },
        openGraph: {
            title: ogTitle,
            description: seo.description,
            url: seo.canonicalPath,
            siteName: SITE_NAME,
            locale: 'zh_CN',
            type: seo.ogType,
            images: [{ url: '/images/og-image.png', width: 1200, height: 630, alt: SITE_NAME }],
        },
        twitter: {
            card: 'summary_large_image',
            title: ogTitle,
            description: seo.description,
            images: ['/images/og-image.png'],
        },
    };
}

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

function ItemSummaryView({ s }: { s: Loaded }) {
    return (
        <LayoutWrapper hideFooter hideFeedbackButton>
            {/* data-ssr-source／data-ssr-version：取数走的哪条路、哪一版数据；排查与发版后实测（W2-3）用 */}
            <article data-ssr-item={s.id} data-ssr-source={s.source} data-ssr-version={s.version} style={S.article}>
                <h1 style={S.h1}>
                    {s.title}
                    {s.edition && <span style={S.edition}>{s.edition}</span>}
                </h1>
                {s.authorLine && <p style={S.authors}>{s.authorLine}</p>}
                {s.measure && <p style={S.measure}>{s.measure}</p>}
                {s.description && <p style={S.desc}>{s.description}</p>}
                <p style={S.loading}>加载中...</p>
            </article>
        </LayoutWrapper>
    );
}

export default async function ItemPage({ params }: Props) {
    const { id } = await params;
    const s = await load(id);
    if (!s) notFound();
    return (
        <>
            <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(s.seo.jsonLd) }} />
            <ItemDetailClient id={id} fallback={<ItemSummaryView s={s} />} />
        </>
    );
}
