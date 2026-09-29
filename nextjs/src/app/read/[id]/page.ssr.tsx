// N5b（overview#213）：阅读页 /item/<id>/read?kind=collated|fulltext[&key=…][&juan=…]。
//
// 文件名带 .ssr：与条目页一样只在全栈构建里是页面（静态导出没有动态路由），切站（#79）后上线。
// 地址约定见 lib/reader-route.ts，与 N3b 条目页的「阅读全文」共用。
//
// - 整理本渲染 CollatedEdition，全文渲染 BookFullText；直接全宽，不套页面框；标题、副题用组件默认值。
// - 每卷各有 <title> 与 canonical（按 kind、key、juan 拼，参数顺序固定）。
// - 服务端按目录校验 kind／key／juan（lib/server/reader-check.ts）：查不到就真 404，不出软 404；
//   查不了（网络错）照常渲染，canonical 回落到不带 key／juan 的地址。
// - 旧入口 ?tab=fulltext／collated 的 308 在 middleware.ssr.ts。
// - 本页读查询串，是按请求渲染的动态页（不走 ISR）。
// - 首屏数据（WEB2，overview#249）：服务端把本书的全文清单、目录与首卷正文一起交给 ReaderClient，
//   浏览器不再走 latest.json → 全站 index/full_text 分片 → index.json → 正文 这条串行链（preload.ts）。
import type { Metadata } from 'next';
import { notFound, permanentRedirect, redirect } from 'next/navigation';
import { getCurrentJsonServer, getCurrentTextServer, getItemServer, getPromotionServer } from '@/lib/server/item-data';
import { checkReader } from '@/lib/server/reader-check';
import { parseItemId } from '@/lib/item-id';
import { summarizeItem } from '@/lib/server/item-summary';
import { resolveItemRedirect } from '@/lib/server/item-redirect';
import { parseReaderQuery, readerHref, readerTitle, juanLabel, legacyCollatedJuanTarget, type ReaderQuery } from '@/lib/reader-route';
import ReaderClient from './ReaderClient';
import { preloadReader } from './preload';
import type { ReaderSeed } from './reader-seed';

// 必须显式 force-dynamic，且不能导出 generateStaticParams：有了它（哪怕返回 []）Next 就把本页当
// SSG／ISR（构建输出里是 ●），请求时一读 searchParams 就抛 DYNAMIC_SERVER_USAGE，每个阅读页都 500。
// 静态导出不打包 .ssr.tsx，不需要它来过 output: 'export'（INT 预合实测，overview#220）。
export const dynamic = 'force-dynamic';

type Props = {
    params: Promise<{ id: string }>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
};

type Loaded = { q: ReaderQuery; title: string; canonical: string; isWork: boolean; chapterTitle?: string };

/** 首屏数据最多等这么久：目录多半已在进程内缓存，慢的只会是正文；等不到就交给浏览器取 */
const PRELOAD_BUDGET_MS = 1500;

/** 返回 null ＝ 真 404。被并条目、草稿升格照条目页一样跳，但落到目标的阅读页 */
async function load(id: string, sp: Record<string, string | string[] | undefined>): Promise<Loaded | null> {
    const q = parseReaderQuery(id, sp);
    if (!q) return null;
    const hit = await getItemServer(id);
    const r = await resolveItemRedirect(id, hit, getPromotionServer);
    if (r) {
        const target = r.to.match(/^\/item\/([0-9a-z]+)$/)?.[1];
        (r.permanent ? permanentRedirect : redirect)(target ? readerHref(target, q) : r.to);
    }
    if (!hit) return null;
    const isWork = parseItemId(id)?.type === 'work';
    const { status: checked, chapterTitle } = await checkReader(id, q, isWork, getCurrentJsonServer);
    if (checked === 'missing') return null;
    // 整理本旧地址（juan=juan/011.json）→ 308 到短形式（juan=011）；已分享出去的链接照常能开
    const legacy = legacyCollatedJuanTarget(id, q);
    if (legacy) permanentRedirect(legacy);
    const canonical = readerHref(id, checked === 'found' ? q : { kind: q.kind });
    return { q, title: summarizeItem(hit.entry, id).title, canonical, isWork, chapterTitle };
}

async function preload(id: string, s: Loaded): Promise<ReaderSeed> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<ReaderSeed>((resolve) => { timer = setTimeout(() => resolve({}), PRELOAD_BUDGET_MS); });
    try {
        return await Promise.race([preloadReader(id, s.q, s.isWork, getCurrentJsonServer, getCurrentTextServer), budget]);
    } finally {
        clearTimeout(timer);
    }
}

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
    const { id } = await params;
    const s = await load(id, await searchParams);
    if (!s) return { title: '未找到', robots: { index: false, follow: false } };
    const title = readerTitle(s.title, s.q, s.chapterTitle);
    const what = s.q.kind === 'collated' ? '整理本' : '全文';
    const description = `${s.title}${s.chapterTitle ?? (s.q.juan ? juanLabel(s.q.juan) : '')}${what}，在线阅读。`;
    const { canonical } = s;
    return {
        title,
        description,
        alternates: { canonical },
        openGraph: { title, description, url: canonical, type: 'book' },
    };
}

export default async function ReaderPage({ params, searchParams }: Props) {
    const { id } = await params;
    const s = await load(id, await searchParams);
    if (!s) notFound();
    const seed = await preload(id, s);
    return <ReaderClient id={id} initial={s.q} bookTitle={s.title} seed={seed} />;
}
