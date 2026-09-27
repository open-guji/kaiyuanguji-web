// W2-1（31 卡 §A）：条目页 /item/<id> 函数按请求服务端渲染。
//
// 文件名带 .ssr：只有全栈构建（KYG_RENDER_MODE=fullstack，测试站）才把它当页面
// （next.config.ts 的 pageExtensions）；正式站静态导出看不到它——动态路由在
// output: 'export' 下没有 generateStaticParams 会直接构建失败，且正式站产物须与改前一致。
//
// 本段只做骨架：服务端取数＋首屏摘要（书名／作者／卷数／简介）直接进 HTML，
// 客户端详情组件照旧挂载。<title> 以外的头部（description、canonical、JSON-LD）、
// 草稿 id 跳转、旧地址 308 归 W2-2；按改动清缓存与 sitemap 归 W2-3。
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import LayoutWrapper from '@/components/layout/LayoutWrapper';
import { getItemServer } from '@/lib/server/item-data';
import { summarizeItem, type ItemSummary } from '@/lib/server/item-summary';
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

type Loaded = ItemSummary & { source: 'h1' | 'current' };

async function load(id: string): Promise<Loaded | null> {
    const hit = await getItemServer(id);
    return hit ? { ...summarizeItem(hit.entry, id), source: hit.source } : null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
    const { id } = await params;
    const s = await load(id);
    if (!s) return { title: '未找到条目' };
    return { title: s.edition ? `${s.title}（${s.edition}）` : s.title };
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
            {/* data-ssr-source：取数走的哪条路（h1／current），排查与实测用 */}
            <article data-ssr-item={s.id} data-ssr-source={s.source} style={S.article}>
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
    return <ItemDetailClient id={id} fallback={<ItemSummaryView s={s} />} />;
}
