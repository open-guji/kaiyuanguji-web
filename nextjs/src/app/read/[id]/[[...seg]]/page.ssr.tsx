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
// - 本页读查询串（只为认旧地址），是按请求渲染的动态页（不走 ISR）。
// - 首屏数据（WEB2，overview#249）：服务端把 manifest、版本目录与首章正文一起交给 ReaderClient，
//   浏览器不再走 manifest → 目录 → 正文 这条串行链（preload.ts）。
import type { Metadata } from 'next';
import { notFound, permanentRedirect, redirect } from 'next/navigation';
import { getCurrentJsonServer, getCurrentTextServer, getItemServer, getPromotionServer } from '@/lib/server/item-data';
import { checkReader, getManifest, type ReaderCheckResult } from '@/lib/server/reader-check';
import { summarizeItem } from '@/lib/server/item-summary';
import { resolveItemRedirect } from '@/lib/server/item-redirect';
import { legacyMarkdownName, markdownPagePath } from '@/lib/markdown-pages';
import { chapterFallbackLabel, parseReaderSegments, readerPath, readerTitle, type ReaderSel } from '@/lib/reader-route';
import { legacyReaderTarget, parseLegacyReaderParams } from '@/lib/legacy-reader';
import ReaderClient from '../ReaderClient';
import { preloadReader } from '../preload';
import type { ReaderSeed } from '../reader-seed';

// 必须显式 force-dynamic，且不能导出 generateStaticParams：有了它（哪怕返回 []）Next 就把本页当
// SSG／ISR（构建输出里是 ●），请求时一读 searchParams 就抛 DYNAMIC_SERVER_USAGE，每个阅读页都 500。
// 静态导出不打包 .ssr.tsx，不需要它来过 output: 'export'（INT 预合实测，overview#220）。
export const dynamic = 'force-dynamic';

type Props = {
    params: Promise<{ id: string; seg?: string[] }>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
};

type Loaded = { sel: ReaderSel; title: string; canonical: string; checked: ReaderCheckResult };

/** 首屏数据最多等这么久：manifest 与目录多半已在进程内缓存，慢的只会是正文；等不到就交给浏览器取 */
const PRELOAD_BUDGET_MS = 1500;

function toParams(sp: Record<string, string | string[] | undefined>): URLSearchParams {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) p.append(k, x);
    return p;
}

/** 返回 null ＝ 真 404。被并条目、草稿升格照条目页一样跳，但落到目标的阅读页 */
async function load(id: string, seg: string[] | undefined, sp: Record<string, string | string[] | undefined>): Promise<Loaded | null> {
    const parsed = parseReaderSegments(id, seg);
    if (!parsed) return null;
    if ('redirect' in parsed) permanentRedirect(parsed.redirect);
    const { sel } = parsed;

    // 旧地址 /read/<id>?kind=…&key=…&juan=…：按 manifest 换算成新地址（没有文本就去条目页）
    if (!seg || seg.length === 0) {
        const legacy = parseLegacyReaderParams(id, toParams(sp));
        if (legacy) permanentRedirect(legacyReaderTarget(legacy, await getManifest(id, getCurrentJsonServer)) ?? `/item/${id}`);
    }

    const hit = await getItemServer(id);
    const r = await resolveItemRedirect(id, hit, getPromotionServer);
    if (r) {
        const target = r.to.match(/^\/item\/([0-9a-z]+)$/)?.[1];
        (r.permanent ? permanentRedirect : redirect)(target ? readerPath(target, sel) : r.to);
    }
    if (!hit) return null;
    const checked = await checkReader(id, sel, getCurrentJsonServer);
    if (checked.status === 'missing') return null;
    const canonical = readerPath(id, { key: sel.key, chapter: checked.status === 'found' ? checked.chapter : undefined });
    return { sel, title: summarizeItem(hit.entry, id).title, canonical, checked };
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

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
    const { id, seg } = await params;
    redirectLegacyMarkdown(id, seg);
    const s = await load(id, seg, await searchParams);
    if (!s) return { title: '未找到', robots: { index: false, follow: false } };
    const chapter = s.checked.chapter;
    const versionLabel = s.checked.version?.label || s.checked.version?.source_name;
    const title = readerTitle(s.title, chapter, s.checked.chapterTitle, versionLabel);
    const what = [s.checked.chapterTitle ?? (chapter ? chapterFallbackLabel(chapter) : ''), versionLabel].filter(Boolean).join('');
    const description = `${s.title}${what}，在线阅读。`;
    const { canonical } = s;
    return {
        title,
        description,
        alternates: { canonical },
        openGraph: { title, description, url: canonical, type: 'book' },
    };
}

export default async function ReaderPage({ params, searchParams }: Props) {
    const { id, seg } = await params;
    redirectLegacyMarkdown(id, seg);
    const s = await load(id, seg, await searchParams);
    if (!s) notFound();
    const seed = await preload(id, s);
    // 首帧照服务端落实的版本与章渲染，与服务端 HTML 一致；查不准（unknown）时按地址里给的
    const initial = { key: s.sel.key, chapter: s.checked.chapter ?? s.sel.chapter };
    return <ReaderClient id={id} initial={initial} bookTitle={s.title} seed={seed} />;
}
