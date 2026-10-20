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
import { getCurrentJsonServer, getCurrentTextHeadServer, getCurrentTextServer, getCurrentUrlServer, getItemServer, getLatestServer, getPromotionServer } from '@/lib/server/item-data';
import { checkReader, isDuiduChapterMeta, type ReaderCheckResult } from '@/lib/server/reader-check';
import { dataVersionKey, type LatestPointer } from '@/lib/data-version';
import { summarizeItem } from '@/lib/server/item-summary';
import { resolveItemRedirect } from '@/lib/server/item-redirect';
import { legacyMarkdownName, markdownPagePath } from '@/lib/markdown-pages';
import { chapterFallbackLabel, dedupeChapterLabel, parseReaderSegments, readerPath, readerTitle, readerVersionName, type ReaderSel } from '@/lib/reader-route';
import ReaderClient from '../ReaderClient';
import { preloadReader, SEED_TEXT_MAX } from '../preload';
import { seedCallKey, type ReaderSeed } from '../reader-seed';
import { leadParagraphs, leadText } from '@/lib/reader-lead';
import type { ReaderLeadData } from '../ReaderLead';
import { simplifyMetadata } from '@/lib/server/simplify';
import { getSiteT } from '@/i18n/translate';
import { startRenderTiming, serverTimingValue, timed, withHopTiming, type RenderTiming } from '@/lib/server/render-timing';
import { withSpeculation, type SpeculativeGetter } from '@/lib/server/speculative-get';
import { isReadSeedEnabled, loadReadSeed, withReadSeed } from '@/lib/server/read-seed';

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

type Fetchers = { json: SpeculativeGetter<typeof getCurrentJsonServer>; text: SpeculativeGetter<typeof getCurrentTextServer> };
type Loaded = {
    sel: ReaderSel; title: string; canonical: string; checked: ReaderCheckResult; timing: RenderTiming; fetchers: Fetchers;
    /** 渲染时的数据版本键（latest.json 的 cacheKey／commitId）：随首屏数据交给浏览器，取对读数据不必先等 latest.json（GUJI-699） */
    dataVersion?: string;
    /** GUJI-358：条目存在、站内没有文本（只有外链文本资源）：页面不出阅读器，指向详情页 */
    noSiteText?: true;
};

/** 首屏数据最多等这么久：manifest 与目录多半已在进程内缓存，慢的只会是正文；等不到就交给浏览器取。
 *  页面是 ISR，超时那次的空壳会被缓存 1 小时（overview#581 实测），所以预算放宽到 4s：冷页首访多等几秒，换爬虫拿到完整页 */
const PRELOAD_BUDGET_MS = 4000;

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
    // overview#345 PR①：单独量 latest.json 这一跳（与下面各取数共用同一份进程内缓存的请求，不多发请求；只记录）。
    // 这一跳本来就在所有取数前面（getCurrentJson 内部先 await latest.json），这里提前等它不增加延迟；失败当作没开 seed。
    const latest = await timed(timing, 'latest', getLatestServer()).catch(() => null);
    // overview#345 方案 B：latest.json 里 readSeed===1 时，manifest 与主版本 index 取自一个 read-seed.json（见 read-seed.ts），否则照旧。
    const baseJson = withHopTiming(timing, getCurrentJsonServer);
    const seedP = isReadSeedEnabled(latest) ? loadReadSeed(id, baseJson) : null;
    // overview#345 PR②：投机预取——在拿到 manifest 之前先把 index 与首章正文发出去，与 manifest 并行（见 speculative-get.ts）。
    // 猜的是「没写版本 ＝ default、没写章 ＝ 001」；猜错只是预取白发，checkReader／preloadReader 仍按 manifest 校验后的版本与章去取，结果不变。
    const fetchers: Fetchers = {
        json: withSpeculation(seedP ? withReadSeed(id, baseJson, seedP) : baseJson),
        text: withSpeculation(withHopTiming(timing, getCurrentTextServer)),
    };
    const guessKey = sel.key ?? 'default';
    const guessChapter = sel.chapter ?? '001';
    const prefetchIndex = () => fetchers.json.prefetch(`items/${id}/${guessKey}/index.json`);
    // 有 seed 时主版本的 index 来自 seed，不预取（省一个请求）；seed 取不到、或地址指定了 seed 不带的别的版本时才补发，保住 #371 的并发读法
    if (seedP) void seedP.then((s) => { if (!s || (sel.key && s.primary.key !== sel.key)) prefetchIndex(); });
    else prefetchIndex();
    fetchers.text.prefetch(`items/${id}/${guessKey}/${guessChapter}.txt`, SEED_TEXT_MAX);
    const [hit, checked] = await Promise.all([
        // 只要书名与跳转信息：先走 current/（与 checkReader 共用 latest.json，冷实例上少 3 跳，overview#322 B1）
        timed(timing, 'item', getItemServer(id, { prefer: 'current' })),
        timed(timing, 'check', checkReader(id, sel, fetchers.json.get)),
    ]);
    const r = await timed(timing, 'redirect', resolveItemRedirect(id, hit, getPromotionServer));
    if (r) {
        const target = r.to.match(/^\/item\/([0-9a-z]+)$/)?.[1];
        (r.permanent ? permanentRedirect : redirect)(target ? readerPath(target, sel) : r.to);
    }
    if (!hit) return null;
    // GUJI-358：检索的「有文本」也算外链文本资源（识典／维基文库链接），站内 book-text 却可能没收。条目存在、只是站内没有文本时不给 404，
    // 也不在这里 redirect()：本页是 ISR，在 ISR 渲染里抛 redirect 会让首次（MISS）响应带两个 Location，CDN 合并成「a, a」，终点 404
    // （Next 16.1.4 本地复现）。改成渲染一个 200 的提示页（noindex，带指向详情页的链接与 meta refresh）。
    // 条目不存在、人物等没有阅读页的类型、版本／章乱填仍是真 404。
    if (checked.status === 'missing' && checked.reason === 'no-manifest' && (hit.entry.type === 'work' || hit.entry.type === 'book')) {
        return { sel, title: summarizeItem(hit.entry, id).title, canonical: `/item/${id}`, checked, timing, fetchers, noSiteText: true };
    }
    if (checked.status === 'missing') return null;
    const canonical = readerPath(id, { key: sel.key, chapter: checked.status === 'found' ? checked.chapter : undefined });
    return { sel, title: summarizeItem(hit.entry, id).title, canonical, checked, timing, fetchers, dataVersion: dataVersionKey(latest as LatestPointer | null) };
}

/**
 * generateMetadata 与页面本体各调一次 load()：用 React cache() 按请求去重，冷实例上同一批取数只走一遍
 * （overview#322 方案 B3）。seg 数组每次调用不是同一个对象，按序列化后的字符串作键。
 */
const loadByKey = cache((id: string, segKey: string) => loadUncached(id, (JSON.parse(segKey) as string[] | null) ?? undefined));
function load(id: string, seg: string[] | undefined): Promise<Loaded | null> {
    return loadByKey(id, JSON.stringify(seg ?? null));
}

/** generateMetadata 与页面本体共用同一份首屏数据（description 取正文开头，overview#581）：按 Loaded 对象记住，只取一次 */
const seedOf = new WeakMap<Loaded, Promise<ReaderSeed>>();
function preload(id: string, s: Loaded): Promise<ReaderSeed> {
    let p = seedOf.get(s);
    if (!p) { p = preloadUncached(id, s); seedOf.set(s, p); }
    return p;
}

async function preloadUncached(id: string, s: Loaded): Promise<ReaderSeed> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<ReaderSeed>((resolve) => { timer = setTimeout(() => resolve({}), PRELOAD_BUDGET_MS); });
    try {
        return await Promise.race([preloadReader(id, s.checked, s.fetchers.json.get, s.fetchers.text.get), budget]);
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
    if (s.noSiteText) return { title: s.title, robots: { index: false, follow: true }, alternates: { canonical: s.canonical } };
    const chapter = s.checked.chapter;
    const versionLabel = readerVersionName(s.checked.version);
    const title = readerTitle(s.title, chapter, s.checked.chapterTitle, versionLabel);
    const what = [dedupeChapterLabel(s.title, s.checked.chapterTitle ?? (chapter ? chapterFallbackLabel(chapter) : '')), versionLabel].filter(Boolean).join('');
    const fallback = getSiteT('zh-Hans')('seo.readOnline', { what: `${s.title}${what}` });
    // description 取首章正文开头（已在首屏数据里，不新增请求）；取不到（预算超时、过大、无正文）就用模板句
    let lead = '';
    if (s.checked.status === 'found' && s.checked.version && chapter) {
        const seed = await preload(id, s);
        const got = seed.calls?.[seedCallKey('getChapter', id, s.checked.version.key, chapter)] as { md?: string } | undefined;
        lead = leadText(got?.md);
    }
    const description = lead ? `${s.title}${what}：${lead}` : fallback;
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

/** 服务端直出的首章正文＋上下章真链接（overview#581 方案 A 第 3 项）；没有首章正文（预算超时、过大、无正文）就不出 */
function buildLead(id: string, s: Loaded, seed: ReaderSeed, head?: { text: string; truncated: boolean } | null): ReaderLeadData | undefined {
    const { checked } = s;
    if (checked.status !== 'found' || !checked.version || !checked.chapter || !checked.index) return undefined;
    const got = seed.calls?.[seedCallKey('getChapter', id, checked.version.key, checked.chapter)] as { md?: string } | undefined;
    const lead = leadParagraphs(got?.md ?? head?.text);
    const paragraphs = lead.paragraphs;
    // 只有章首片段时，片段之后一定还有正文：无论片段里能切出几段都要给「继续阅读」
    const truncated = lead.truncated || (got?.md === undefined && head?.truncated === true);
    if (paragraphs.length === 0) return undefined;
    const chapters = checked.index.chapters;
    const at = chapters.findIndex((c) => c.file === checked.chapter);
    const link = (i: number) => {
        const c = chapters[i];
        if (!c) return undefined;
        return { href: readerPath(id, { key: s.sel.key, chapter: c.file }), label: dedupeChapterLabel(s.title, c.title?.trim() || chapterFallbackLabel(c.file)) || chapterFallbackLabel(c.file) };
    };
    return {
        paragraphs,
        truncated,
        selfHref: s.canonical,
        prev: at > 0 ? link(at - 1) : undefined,
        next: at >= 0 ? link(at + 1) : undefined,
        itemHref: `/item/${id}`,
        itemLabel: `${s.title}·书目详情`,
    };
}

/**
 * 大章书（章 >256KB，不进种子）的首屏 lead：另取 `.txt` 的前 16KB（Range，overview#586）。
 * 与首屏数据并行发出（不知道哪些章会超限，也不为此串在种子后面多等一轮）；种子里有正文时结果直接丢弃。
 * 失败（超时、源站不认 Range）得 null，页面与改前一致。
 */
function startLeadHead(id: string, s: Loaded): Promise<{ text: string; truncated: boolean } | null> {
    const { checked } = s;
    if (checked.status !== 'found' || !checked.version || !checked.chapter) return Promise.resolve(null);
    if (isDuiduChapterMeta(checked.index?.chapters.find((c) => c.file === checked.chapter))) return Promise.resolve(null);
    return getCurrentTextHeadServer(`items/${id}/${checked.version.key}/${checked.chapter}.txt`).catch(() => null);
}

/**
 * 对读章的数据文件（char／punct／cord／entity／norm）在 <head> 里 preload（GUJI-631）：
 * 原先要等 JS 下完、阅读器挂上才发这几个请求（慢网下 JS 要 5 秒以上），preload 让它们与 JS 并行下载。
 * 地址与浏览器端 cos-storage 的 getTextFileLegacy 逐字一致（current/ ＋ ?v=<版本键>）；h1 哈希寻址布局地址不同，不做。
 * 页面被 CDN 缓存期间数据换了版本，preload 的地址会对不上（白下一份），一小时内自愈，可接受。
 */
/** cord 只有书影栏的字框用，书影栏在窄屏（≤859px）收起：只在宽屏 preload（GUJI-700） */
const WIDE_MEDIA = '(min-width: 860px)';

/** 当前章的章条目（对读章才返回；h1 哈希寻址布局地址不同，不做） */
function duiduMeta(s: Loaded): { key: string; meta: Record<string, unknown> & { file: string } } | null {
    if (process.env.NEXT_PUBLIC_DATA_LAYOUT === 'hashed') return null;
    const { checked } = s;
    if (checked.status !== 'found' || !checked.version || !checked.chapter) return null;
    const meta = checked.index?.chapters.find((c) => c.file === checked.chapter) as (Record<string, unknown> & { file: string }) | undefined;
    return isDuiduChapterMeta(meta) ? { key: checked.version.key, meta: meta! } : null;
}

async function duiduPreloadUrls(id: string, s: Loaded): Promise<{ href: string; media?: string }[]> {
    const d = duiduMeta(s);
    if (!d) return [];
    const { meta } = d;
    const files = ['char_file', 'punct_file', 'cord_file', 'entity_file', 'norm_file']
        .map((k) => ({ k, f: meta![k] }))
        .filter((x): x is { k: string; f: string } => typeof x.f === 'string' && /^[\w.-]+$/.test(x.f));
    const urls = await Promise.all(files.map(async ({ k, f }) => {
        const href = await getCurrentUrlServer(`items/${id}/${d.key}/${f}`).catch(() => null);
        return href ? { href, ...(k === 'cord_file' ? { media: WIDE_MEDIA } : {}) } : null;
    }));
    return urls.filter((u): u is { href: string; media?: string } => !!u);
}

/**
 * 对读章的生僻字子集（GUJI-701）：打包时给对读章生成了 <章>.font.woff2（约 10KB），章条目记 font_file／font_range。
 * 页面里追加同字族的 @font-face（HanaMinA、HanaMinB 各一条，同一地址只下一次）：同字族 unicode-range 重叠时后定义的先查，
 * 这些字就从子集取，不再去下 globals.css 里花园明朝的大分片（这一章原先 19 片、3.6MB）；子集取不到时照旧回落分片。
 * 只管首屏这一章：站内换章不重渲染服务端，新章的生僻字照旧走分片。
 */
const FONT_RANGE_RE = /^U\+[0-9A-F]{4,6}(?:-[0-9A-F]{4,6})?(?:,U\+[0-9A-F]{4,6}(?:-[0-9A-F]{4,6})?)*$/;

async function chapterFont(id: string, s: Loaded): Promise<{ href: string; range: string } | null> {
    const d = duiduMeta(s);
    const file = d?.meta.font_file;
    const range = d?.meta.font_range;
    if (typeof file !== 'string' || !/^[\w.-]+\.woff2$/.test(file)) return null;
    if (typeof range !== 'string' || range.length > 50_000 || !FONT_RANGE_RE.test(range)) return null;
    const href = await getCurrentUrlServer(`items/${id}/${d!.key}/${file}`).catch(() => null);
    // 地址要原样放进 CSS 的 url("…")：带引号、括号、反斜杠、空白的不用
    if (!href || /["'()\\\s]/.test(href)) return null;
    return { href, range };
}

function chapterFontCss({ href, range }: { href: string; range: string }): string {
    return ['HanaMinA', 'HanaMinB']
        .map((f) => `@font-face{font-family:"${f}";font-style:normal;font-weight:400;font-display:swap;src:url("${href}") format("woff2");unicode-range:${range}}`)
        .join('');
}

/** 站内没有文本的条目（GUJI-358）：提示＋指向详情页；meta refresh 让浏览器自动过去，爬虫与脚本看到的是 200 的 noindex 页 */
function NoSiteText({ id, title }: { id: string; title: string }) {
    const to = `/item/${id}`;
    return (
        <main style={{ maxWidth: 640, margin: '0 auto', padding: '48px 16px' }}>
            <meta httpEquiv="refresh" content={`0;url=${to}`} />
            <h1>{title}</h1>
            <p>本站暂无这部书的站内文本。</p>
            <p><a href={to}>前往详情页</a>，查看外站文本与影像资源。</p>
        </main>
    );
}

export default async function ReaderPage({ params }: Props) {
    const { id, seg } = await params;
    redirectLegacyMarkdown(id, seg);
    const s = await load(id, seg);
    if (!s) notFound();
    if (s.noSiteText) return <NoSiteText id={id} title={s.title} />;
    const headP = startLeadHead(id, s);
    // React 19 把 <link rel="preload"> 提到 <head>
    const [preloads, font] = await Promise.all([
        duiduPreloadUrls(id, s).catch(() => [] as { href: string; media?: string }[]),
        chapterFont(id, s).catch(() => null),
    ]);
    const seed = { ...(await timed(s.timing, 'preload', preload(id, s))), ...(s.dataVersion ? { dataVersion: s.dataVersion } : {}) };
    const hasSeedMd = s.checked.status === 'found' && s.checked.version && s.checked.chapter
        && (seed.calls?.[seedCallKey('getChapter', id, s.checked.version.key, s.checked.chapter)] as { md?: string } | undefined)?.md !== undefined;
    const head = hasSeedMd ? null : await timed(s.timing, 'leadHead', headP);
    // 首帧照服务端落实的版本与章渲染，与服务端 HTML 一致；查不准（unknown）时按地址里给的
    const initial = { key: s.sel.key, chapter: s.checked.chapter ?? s.sel.chapter };
    const timing = serverTimingValue(s.timing);
    console.log(`[reader-timing] /read/${id}${seg?.length ? `/${seg.join('/')}` : ''} ${timing}`);
    return (
        <>
            <ReaderClient id={id} initial={initial} bookTitle={s.title} seed={seed} lead={buildLead(id, s, seed, head)} />
            {preloads.map(({ href, media }) => <link key={href} rel="preload" as="fetch" crossOrigin="anonymous" href={href} media={media} />)}
            {font && <link rel="preload" as="font" type="font/woff2" crossOrigin="anonymous" href={font.href} />}
            {/* 不带 precedence 的 <style> 留在 body 里，排在 globals.css 之后＝后定义（GUJI-701） */}
            {font && <style id="kyg-chapter-font" dangerouslySetInnerHTML={{ __html: chapterFontCss(font) }} />}
            {/* overview#322 方案 D：首次渲染的分段计时（Server-Timing 语法），不渲染、不参与交互 */}
            <script type="application/json" id="kyg-render-timing" dangerouslySetInnerHTML={{ __html: JSON.stringify(timing) }} />
        </>
    );
}
