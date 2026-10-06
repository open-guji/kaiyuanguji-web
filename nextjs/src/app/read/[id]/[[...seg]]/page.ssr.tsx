// 阅读页 /read/<id>[/<key>][/<章>]（overview#307 E 块，规格 §六；独立的一级目录，overview#267）。
//
//   /read/<id>            主版本（default）第一章
//   /read/<id>/<章>       主版本某章（三位编号）
//   /read/<id>/<key>      其他版本第一章
//   /read/<id>/<key>/<章> 其他版本某章
//
// 第二段纯数字＝章号，字母开头＝版本 key；`/read/<id>/default/…` 308 到不带 default 的形式。地址约定见 lib/reader-route.ts。
// 只认新结构（manifest＋<key>/，用户 09-30 定）：条目没有 manifest ＝ 没有文本 ＝ 真 404。
// 旧地址（?kind=&key=&juan=）换算成新地址 308，见 lib/legacy-reader.ts；旧的 /item/<id>/read 见 app/item/[id]/read/page.ssr.tsx；
// 条目页页签（?tab=）与 /read/<说明页名> 的跳转在 middleware.ssr.ts。
//
// 文件放在可选全捕获段 [[...seg]] 下（/read/<id> 也落在这里）；文件名带 .ssr：与条目页一样只在全栈构建里是页面
// （静态导出没有动态路由），切站（#79）后上线。
//
// - 渲染 book-index-ui 的统一阅读器 TextReader（整理本与全文合一，版本下拉含全部版本）；直接全宽，不套页面框。
// - 每章各有 <title> 与 canonical（不带章号的短地址 canonical 指向第一章的全形）。
// - 服务端按 manifest 与版本目录校验版本 key／章号（lib/server/reader-check.ts）：查不到就真 404，不出软 404；
//   查不了（网络错）照常渲染，canonical 回落到不带章号的地址。
// - 本页走 ISR，CDN 按 s-maxage 缓存（overview#322：原先 force-dynamic、每次访问都冷渲染，
//   首访 1.5–4.5 秒、约 5% 超过 EdgeOne 回源时限回 503）。页面因此不能读查询串：
//   旧查询串地址（?kind=&key=&juan=）的换算只在 middleware.ssr.ts 里做（取数出错时 307 条目页）。
//   被并条目、草稿升格的跳转也由中间件先出（ISR 未命中时页面抛 redirect 会把 Location 写两遍，vercel/next.js#82117），
//   页面里的跳转留作 RSC 导航的兜底。数据发版后由 /internal/revalidate 的 read 开关整体失效。
// - 首屏数据（WEB2，overview#249）：服务端把 manifest、版本目录与首章正文一起交给 ReaderClient，
//   浏览器不再走 manifest → 目录 → 正文 这条串行链（preload.ts）。
import '@/lib/server/local-public-data'; // 本地联调读 public/data/（KYG_LOCAL_PUBLIC_DATA=1）；正式构建不生效
import { cache } from 'react';
import type { Metadata } from 'next';
import { notFound, permanentRedirect, redirect } from 'next/navigation';
import { getCurrentJsonServer, getCurrentTextServer, getItemServer, getPromotionServer } from '@/lib/server/item-data';
import { checkReader, type ReaderCheckResult } from '@/lib/server/reader-check';
import { summarizeItem } from '@/lib/server/item-summary';
import { resolveItemRedirect } from '@/lib/server/item-redirect';
import { legacyMarkdownName, markdownPagePath } from '@/lib/markdown-pages';
import { chapterFallbackLabel, parseReaderSegments, readerPath, readerTitle, readerVersionName, type ReaderSel } from '@/lib/reader-route';
import ReaderClient from '../ReaderClient';
import { preloadReader } from '../preload';
import type { ReaderSeed } from '../reader-seed';
import { simplifyMetadata } from '@/lib/server/simplify';
import { getSiteT } from '@/i18n/translate';
import { startRenderTiming, serverTimingValue, timed, type RenderTiming } from '@/lib/server/render-timing';

// ISR（与条目页同一套，overview#322）：CDN 按 s-maxage 缓存 1 小时，构建时一条都不预渲染。
// 有了 generateStaticParams 页面就是 SSG／ISR：此后页面里一读 searchParams 就抛 DYNAMIC_SERVER_USAGE、全 500，
// 所以 Props 里没有 searchParams（overview#220 的教训）。
export const revalidate = 3600;
export const dynamicParams = true;

export async function generateStaticParams(): Promise<{ id: string; seg?: string[] }[]> {
    return [];
}

type Props = {
    params: Promise<{ id: string; seg?: string[] }>;
};

type Loaded = { sel: ReaderSel; title: string; canonical: string; checked: ReaderCheckResult; timing: RenderTiming };

/** 首屏数据最多等这么久：manifest 与目录多半已在进程内缓存，慢的只会是正文；等不到就交给浏览器取 */
const PRELOAD_BUDGET_MS = 1500;

/**
 * 返回 null ＝ 真 404。被并条目、草稿升格照条目页一样跳，但落到目标的阅读页。
 *
 * 条目（latest.json → current/entry，overview#322 B1；原先走 h1 指针 → 根清单 → 分片 → 条目 4 跳）与
 * manifest／版本目录（latest.json → manifest → index）两条取数链并行取，latest.json 两边共用一次。checkReader 自己兜住网络错（unknown），
 * 条目查不到时它的结果不用，多取的那次落进 LRU。
 */
async function loadUncached(id: string, seg: string[] | undefined): Promise<Loaded | null> {
    const parsed = parseReaderSegments(id, seg);
    if (!parsed) return null;
    if ('redirect' in parsed) permanentRedirect(parsed.redirect);
    const { sel } = parsed;

    // overview#322 方案 D：分段计时（只记录，见 lib/server/render-timing.ts）
    const timing = startRenderTiming();
    const [hit, checked] = await Promise.all([
        // 只要书名与跳转信息：先走 current/（与 checkReader 共用 latest.json，冷实例上少 3 跳，overview#322 B1）
        timed(timing, 'item', getItemServer(id, { prefer: 'current' })),
        timed(timing, 'check', checkReader(id, sel, getCurrentJsonServer)),
    ]);
    const r = await timed(timing, 'redirect', resolveItemRedirect(id, hit, getPromotionServer));
    if (r) {
        const target = r.to.match(/^\/item\/([0-9a-z]+)$/)?.[1];
        (r.permanent ? permanentRedirect : redirect)(target ? readerPath(target, sel) : r.to);
    }
    if (!hit) return null;
    if (checked.status === 'missing') return null;
    const canonical = readerPath(id, { key: sel.key, chapter: checked.status === 'found' ? checked.chapter : undefined });
    return { sel, title: summarizeItem(hit.entry, id).title, canonical, checked, timing };
}

/**
 * generateMetadata 与页面本体各调一次 load()：用 React cache() 按请求去重，冷实例上同一批取数只走一遍
 * （overview#322 方案 B3）。seg 数组每次调用不是同一个对象，按序列化后的字符串作键。
 */
const loadByKey = cache((id: string, segKey: string) => loadUncached(id, (JSON.parse(segKey) as string[] | null) ?? undefined));
function load(id: string, seg: string[] | undefined): Promise<Loaded | null> {
    return loadByKey(id, JSON.stringify(seg ?? null));
}

async function preload(id: string, s: Loaded): Promise<ReaderSeed> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<ReaderSeed>((resolve) => { timer = setTimeout(() => resolve({}), PRELOAD_BUDGET_MS); });
    try {
        return await Promise.race([preloadReader(id, s.checked, getCurrentJsonServer, getCurrentTextServer), budget]);
    } finally {
        clearTimeout(timer);
    }
}

/** 旧的说明页地址（/read/assistant 等）落到这里：308 到 /read/md/<名> */
function redirectLegacyMarkdown(id: string, seg: string[] | undefined) {
    if (seg && seg.length > 0) return;
    const name = legacyMarkdownName(id);
    if (name) permanentRedirect(markdownPagePath(name));
}

async function buildMetadata({ params }: Props): Promise<Metadata> {
    const { id, seg } = await params;
    redirectLegacyMarkdown(id, seg);
    const s = await load(id, seg);
    if (!s) return { title: getSiteT('zh-Hans')('seo.notFound'), robots: { index: false, follow: false } };
    const chapter = s.checked.chapter;
    const versionLabel = readerVersionName(s.checked.version);
    const title = readerTitle(s.title, chapter, s.checked.chapterTitle, versionLabel);
    const what = [s.checked.chapterTitle ?? (chapter ? chapterFallbackLabel(chapter) : ''), versionLabel].filter(Boolean).join('');
    const description = getSiteT('zh-Hans')('seo.readOnline', { what: `${s.title}${what}` });
    const { canonical } = s;
    return {
        title,
        description,
        alternates: { canonical },
        openGraph: { title, description, url: canonical, type: 'book' },
    };
}

// 服务端直出的 title／meta 一律简体：数据部分（书名、分类、回目、检索词）在这里统一转（overview#337）
export async function generateMetadata(props: Props): Promise<Metadata> {
    return simplifyMetadata(await buildMetadata(props));
}

export default async function ReaderPage({ params }: Props) {
    const { id, seg } = await params;
    redirectLegacyMarkdown(id, seg);
    const s = await load(id, seg);
    if (!s) notFound();
    const seed = await timed(s.timing, 'preload', preload(id, s));
    // 首帧照服务端落实的版本与章渲染，与服务端 HTML 一致；查不准（unknown）时按地址里给的
    const initial = { key: s.sel.key, chapter: s.checked.chapter ?? s.sel.chapter };
    const timing = serverTimingValue(s.timing);
    console.log(`[reader-timing] /read/${id}${seg?.length ? `/${seg.join('/')}` : ''} ${timing}`);
    return (
        <>
            <ReaderClient id={id} initial={initial} bookTitle={s.title} seed={seed} />
            {/* overview#322 方案 D：首次渲染的分段计时（Server-Timing 语法），不渲染、不参与交互 */}
            <script type="application/json" id="kyg-render-timing" dangerouslySetInnerHTML={{ __html: JSON.stringify(timing) }} />
        </>
    );
}
