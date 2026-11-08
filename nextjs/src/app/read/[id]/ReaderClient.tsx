'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { TextReader, type ReaderInitialChapter, createTextApi, useConvert, readerManifest, type ReaderReportContext, type TextLocation, type TextLocationCause } from 'book-index-ui';
import LayoutWrapper from '@/components/layout/LayoutWrapper';
import { useFeedback, useFeedbackPageContext } from '@/components/feedback/FeedbackProvider';
import BimLocaleProvider from '@/components/common/BimLocaleProvider';
import { useSource } from '@/components/common/SourceContext';
import { getTransport } from '@/lib/transport';
import { seedTextFileVersion } from '@/lib/cos-storage';
import { loadProofIndex, parsePending, proofInvite } from '@/lib/proofing';
import ProofingNotice from './ProofingNotice';
import TextSourceMenu from './TextSourceMenu';
import type { ReadTextRow } from '@/lib/read-texts';
import { textVersionsOf, type TextVersions } from './TextVersionChip';
import { loadFacsimile } from '@/lib/facsimile';
import { getJson, TEXT_FILE_BASE } from '@/lib/text-file';
import { SITE_NAME } from '@/lib/constants';
import { parseReaderSegments, readerPath, readerTitle, readerVersionName, splitReaderPathname, type ReaderSel } from '@/lib/reader-route';
import { readerFeedbackLabel } from '@/lib/feedback';
import { useSiteT } from '@/i18n/use-site-t';
import { seedCallKey, seedTransport, type ReaderSeed } from './reader-seed';
import { createProofStore, proofPlugin, useProofPref } from './ReaderProof';
import { downloadPlugin } from './plugins/download-plugin';
import { versionChipPlugin } from './plugins/version-chip-plugin';
import { fontPlugin } from './plugins/font-plugin';
import { reportPlugin } from './plugins/report-plugin';
import { fulltextPlugin } from './plugins/fulltext-plugin';
import type { ReaderPlugin } from 'book-index-ui';
import { createCompareStore, useComparePlugin } from '@/components/compare/compare-plugin';
import { useCompareTarget } from '@/components/compare/useCompare';

interface ReaderClientProps {
    id: string;
    /** 服务端按地址落实的版本 key（缺省＝主版本）与章号；首帧照它渲染，与服务端 HTML 一致 */
    initial: ReaderSel;
    /** 书名，用于 <title> 与反馈上下文 */
    bookTitle: string;
    /** 版本名（Book 的 edition，如「清乾隆六十年武英殿刻本」）：书名后直接显示，不藏在选择框里；Work 没有 */
    edition?: string;
    /** 作品下各条目的文本来源（entry.read_texts，自建本在前）；不足两份时不出选择 */
    sources?: ReadTextRow[];
    /** 服务端取好的首屏数据（manifest、版本目录、首章正文），见 reader-seed.ts；缺省则全由浏览器取 */
    seed?: ReaderSeed;
    /** 服务端直出的首章正文＋上下章链接（给爬虫看的同一章正文）；交给阅读器的 initialChapter，阅读器内容出来后自己卸载 */
    lead?: ReaderInitialChapter;
}

/**
 * 翻章、换版本时同步地址栏、<title> 与 canonical，不整页刷新。
 * 用 history.pushState（Next 会同步到路由状态）而不是 router.push：
 * 后者对这个动态页会再请求一次服务端，没有必要。
 *
 * 每翻一章留一条历史，按浏览器返回回到上一章（overview#267 P2-3）；下面两种情况改用 replaceState：
 *   - 首帧：服务端给的地址与规范写法可能只差一截（短地址补成带章号的全形），不该多出一条；
 *   - 阅读器自己纠正位置（cause=auto：地址没带章号、章号无效，组件回落到第一章）：这不是读者翻的，与上一条合并。
 */
function syncLocation(id: string, sel: ReaderSel, title: string, opts: { push: boolean; updateCanonical: boolean; hash?: string | null }) {
    const href = readerPath(id, sel);
    // 章内标题位置（GUJI-240）写在 #页:列:格；canonical 不带它。?cmp=（对校）随翻页、换册保留，canonical 不带
    // 地址的路径没变（首帧、只改 #）时查询串原样保留（?proof=、?ft= 等是别的功能在读，不该被同步冲掉）；
    // 换了章或册，只带 ?cmp=
    const cmp = new URLSearchParams(window.location.search).get('cmp');
    const search = window.location.pathname === href ? window.location.search : cmp ? `?cmp=${encodeURIComponent(cmp)}` : '';
    const full = `${href}${search}${opts.hash ? `#${opts.hash}` : ''}`;
    if (window.location.pathname + window.location.search + window.location.hash !== full) {
        if (opts.push) window.history.pushState(window.history.state, '', full);
        else window.history.replaceState(window.history.state, '', full);
    }
    document.title = `${title} - ${SITE_NAME}`;
    const canonical = opts.updateCanonical ? document.querySelector<HTMLLinkElement>('link[rel="canonical"]') : null;
    if (canonical) canonical.href = new URL(href, canonical.href).href;
}

/** 地址的 hash → 章内格位（`页:列:格[子列]`，或范围 `起~止`），或 `e=<实体id[,…]>`（标出本章提到该实体的全部专名号）；
 *  别的（站内其他用途的 #）不认 */
export function anchorFromHash(raw: string): string | null {
    let h = raw.replace(/^#/, '');
    try { h = decodeURIComponent(h); } catch { return null; }
    if (/^e=[\w-]+(,[\w-]+)*$/.test(h)) return h;
    return /^\d+:\d+:-?\d+[ab]?(~\d+:\d+:-?\d+[ab]?)?$/.test(h) ? h : null;
}

const sameSel = (a: ReaderSel, b: ReaderSel) => (a.key ?? '') === (b.key ?? '') && (a.chapter ?? '') === (b.chapter ?? '');

/** 版本名与章名（<title>、反馈上下文用）：取 manifest 与版本目录，服务端给了种子就不发请求；取不到就没有 */
/**
 * 这一章要不要请读者去校对（返回章号，不要则 undefined）。
 * 先看 COS 上的待审单总表（中心库每日发布）：列了这一章就以它为准，取到了总表却没列这一章就不请；
 * 只有总表取不到时才退回 book-text：章条目 proofing: true、声明了待审单且没清空。
 */
async function proofVolOf(id: string, versionKey: string, chapter: { file?: string } | undefined, transport: ReturnType<typeof getTransport>): Promise<string | undefined> {
    const stem = chapter?.file ? chapter.file.replace(/\.[^.]+$/, '') : undefined;
    if (!stem) return undefined;
    const invite = proofInvite(await loadProofIndex(), id, stem, chapter);
    if (invite === 'yes') return stem;
    if (invite === 'no') return undefined;
    const raw = await getJson(transport, id, versionKey, invite.pendingFile).catch(() => null);
    if (raw && parsePending(raw).cells.length === 0) return undefined;
    return stem;
}

function useTextMeta(id: string, sel: ReaderSel, transport: ReturnType<typeof getTransport>) {
    const api = useMemo(() => createTextApi(transport), [transport]);
    const [meta, setMeta] = useState<{ at: string; versionLabel?: string; kind?: string; chapterTitle?: string; proofVol?: string; feedbackVol?: string; versions?: TextVersions } | null>(null);
    const at = `${id}|${sel.key ?? ''}|${sel.chapter ?? ''}`;
    useEffect(() => {
        let cancelled = false;
        (async () => {
            const manifest = readerManifest(await api.getManifest(id));
            const version = manifest?.versions.find((v) => v.key === (sel.key ?? 'default')) ?? manifest?.versions[0];
            if (!version) return;
            const index = await api.getIndex(id, version.key);
            const chapter = index?.chapters.find((c) => (sel.chapter ? c.file === sel.chapter : true));
            const title = sel.chapter ? chapter?.title?.trim() : undefined;
            // 版本号只有本项目自做的 original 版本记（文本／标点／专名三线），别的来源不出
            const versions = (version as { is_original?: boolean }).is_original ? textVersionsOf(chapter) : undefined;
            const base = { at, versionLabel: readerVersionName(version), kind: version.kind, chapterTitle: title || undefined, versions };
            // 版本名、章名先给（标题、反馈标签用），校对提示另取，不让它们等网络
            if (!cancelled) setMeta(base);
            const proofVol = await proofVolOf(id, version.key, chapter, transport);
            if (!cancelled && proofVol) return setMeta({ ...base, proofVol });
            // 不在校对、文本已到 1.x（章条目 text_version 主版本 ≥1）：问题去反馈页
            const stem = chapter?.file ? chapter.file.replace(/\.[^.]+$/, '') : undefined;
            if (!cancelled && stem && versions && Number(versions.text.split('.')[0]) >= 1) setMeta({ ...base, feedbackVol: stem });
        })().catch(() => {});
        return () => { cancelled = true; };
    }, [api, transport, id, sel.key, sel.chapter, at]);
    return meta?.at === at ? meta : null;
}

/** 主版本 key：阅读页 manifest 里有 default 就是它，否则（目录型 default 被隐藏，overview#456）是第一份版本 */
function primaryKeyOf(m: unknown): string | null {
    const versions = (m as { versions?: { key?: string }[] } | null | undefined)?.versions;
    if (!Array.isArray(versions) || versions.length === 0) return null;
    return versions.find((v) => v.key === 'default')?.key ?? versions[0].key ?? null;
}

function Reader({ id, initial, bookTitle, edition, sources, seed, lead }: ReaderClientProps) {
    const router = useRouter();
    const { source } = useSource();
    // 服务端给的数据版本键：取对读数据不再先等 latest.json（GUJI-699）。只在浏览器端记（服务端的模块状态跨请求共享）
    if (typeof window !== 'undefined') seedTextFileVersion(seed?.dataVersion, seed?.dataVersionAt);
    const transport = useMemo(() => seedTransport(getTransport(source), seed?.calls), [source, seed]);
    const [sel, setSel] = useState<ReaderSel>(initial);
    // 受控的版本 key 必须是 manifest 里真有的：服务端种子里有 manifest 就同步算出（正常路径）；
    // 没有（预取超时、失败）先按 default 挂阅读器，浏览器取到 manifest 后若主版本不是 default（目录型 default 被隐藏）再换过去
    const [primary, setPrimary] = useState<string | null>(() => primaryKeyOf(readerManifest(seed?.calls?.[seedCallKey('getTextManifest', id)] as any)));
    useEffect(() => {
        if (primary !== null) return;
        let cancelled = false;
        (async () => primaryKeyOf(readerManifest(await (transport as { getTextManifest: (id: string) => Promise<any> }).getTextManifest(id))))()
            .catch(() => null)
            .then((k) => { if (!cancelled) setPrimary(k ?? 'default'); });
        return () => { cancelled = true; };
    }, [id, transport, primary]);

    // 浏览器前进／后退：地址变了而状态没变（我们自己 pushState 的不算，那时两者已一致），状态跟着地址走。
    // 首帧不查（服务端已按地址渲染），只在路径之后变了才跟
    const pathname = usePathname();
    const seenPath = useRef(pathname);
    useEffect(() => {
        if (seenPath.current === pathname) return;
        seenPath.current = pathname;
        const p = splitReaderPathname(pathname);
        if (!p || p.id !== id) return;
        const parsed = parseReaderSegments(id, p.segs);
        if (parsed && 'sel' in parsed) setSel((prev) => (sameSel(prev, parsed.sel) ? prev : parsed.sel));
    }, [id, pathname]);

    const meta = useTextMeta(id, sel, transport);

    // 章内标题（GUJI-240）：地址的 #页:列:格 交给阅读器滚过去；读者在目录点标题，地址跟着改。
    // 首帧从地址读（服务端看不到 hash），之后只跟 hashchange（手改地址、点站内 # 链接）
    const [urlAnchor, setUrlAnchor] = useState<string | null>(null);
    const [hash, setHash] = useState<string | null>(null);
    useEffect(() => {
        const read = () => {
            const a = anchorFromHash(window.location.hash);
            setUrlAnchor(a);
            setHash(a);
        };
        read();
        window.addEventListener('hashchange', read);
        return () => window.removeEventListener('hashchange', read);
    }, []);

    // 首帧的 canonical 以服务端为准（章号查不准时它会回落到不带章号的地址），之后翻章再跟着改。
    const synced = useRef(false);
    const pushNext = useRef(false);
    // 书名、版本名是数据，按繁简偏好转（useConvert）；<title> 挂载后跟随读者的繁简选择（overview#337）
    const { convert } = useConvert();
    useEffect(() => {
        syncLocation(id, sel, convert(readerTitle(bookTitle, sel.chapter, meta?.chapterTitle, meta?.versionLabel)), {
            push: synced.current && pushNext.current,
            updateCanonical: synced.current,
            hash,
        });
        pushNext.current = false;
        synced.current = true;
    }, [id, sel, bookTitle, meta, convert, hash]);

    const primaryRef = useRef(primary);
    primaryRef.current = primary;
    const onLocationChange = useCallback((loc: TextLocation, cause: TextLocationCause) => {
        // 主版本还没算出来（种子缺失、浏览器还在取 manifest）时，阅读器先按 default 挂载；若主版本其实不是 default
        // （目录型 default 被隐藏），它取到 manifest 后会以 auto 通知「回到主版本第一章」。那不是读者翻的：
        // 只记下主版本 key，别动 sel，否则地址里的章号被冲掉（/read/<id>/004 变成 001）。
        if (cause === 'auto' && primaryRef.current === null && loc.isDefault) {
            setPrimary(loc.key);
            return;
        }
        const next: ReaderSel = { key: loc.isDefault ? undefined : loc.key, chapter: loc.chapter ?? undefined };
        // 读者翻章、切版本留历史；阅读器自己纠正位置（auto）与上一条合并
        pushNext.current = cause !== 'auto';
        setSel((prev) => (sameSel(prev, next) ? prev : next));
        // 点了章内标题：地址带上它；读者换章、换版本：去掉旧的；阅读器自己纠正位置不动
        if (cause !== 'auto') setHash(loc.anchor ?? null);
    }, []);
    const onNavigate = useCallback((target: string) => router.push(`/item/${target}`), [router]);

    // N7：本页反馈上下文（书名 · 版本 · 章），导航栏「反馈」和选字「报错」都带上；章号另随 pageUrl 提交。
    // 「卷N」「第 N 章」走字典
    const t = useSiteT();
    const feedbackContext = useMemo(
        () => ({
            resourceId: id,
            label: readerFeedbackLabel(
                convert(bookTitle),
                { version: meta?.versionLabel && convert(meta.versionLabel), kind: meta?.kind, chapter: sel.chapter },
                t,
            ),
        }),
        [id, bookTitle, meta, sel.chapter, convert, t],
    );
    useFeedbackPageContext(feedbackContext);
    // 阅读器右栏「报告错字」→ 同一个反馈弹窗，带上书名、条目 id、章、位置锚点与选中文字
    const { open: openFeedback } = useFeedback();
    const onReportError = useCallback((ctx: ReaderReportContext) => {
        openFeedback({
            context: {
                resourceId: ctx.entryId || id,
                label: feedbackContext.label,
                quote: ctx.selectedText,
                anchor: ctx.anchor,
            },
            type: 'bug',
        });
    }, [openFeedback, id, feedbackContext.label]);
    // 对校（A41）：对照本来自 ?cmp=，来源行的「對校」按钮与阅读器里的插件共用；插件经 store 与外层互通
    // 同一本书的其他版本（如文渊阁光盘本）：章文件与底本一一对应，可整章对校；对照本写成 ?cmp=<本条目id>-<版本key>
    const [siblings, setSiblings] = useState<{ key: string; label: string }[]>([]);
    const baseKey = sel.key ?? primary ?? 'default';
    useEffect(() => {
        let dead = false;
        (async () => {
            const m = readerManifest(await (transport as { getTextManifest: (id: string) => Promise<any> }).getTextManifest(id));
            const vs = (m as { versions?: { key?: string; kind?: string; label?: string; edition_label?: string; chapters_total?: number }[] } | null)?.versions;
            if (dead || !Array.isArray(vs)) return;
            setSiblings(vs.filter((v) => v.key && v.key !== baseKey && v.kind === 'transcription' && (v.chapters_total ?? 0) > 1).map((v) => ({ key: v.key as string, label: v.label ?? v.edition_label ?? v.key as string })));
        })().catch(() => {});
        return () => { dead = true; };
    }, [id, transport, baseKey]);
    const siblingKeys = useMemo(() => siblings.map((v) => v.key), [siblings]);
    const compareSources = useMemo(
        () => [...(sources ?? []).filter((r) => r.id !== id).map((r) => ({ id: r.id, label: r.label })), ...siblings.map((v) => ({ id: `${id}-${v.key}`, label: v.label }))],
        [sources, id, siblings],
    );
    const compareSourceIds = useMemo(() => (sources ?? []).filter((r) => r.id !== id).map((r) => r.id), [sources, id]);
    const compareTarget = useCompareTarget(id, compareSourceIds, siblingKeys);
    const compareStore = useMemo(() => createCompareStore(), []);
    const comparePlugin = useComparePlugin({ id, sources: compareSources, transport, target: compareTarget.target, setTarget: compareTarget.setTarget, store: compareStore });
    // 对校页不进搜索（canonical 本来就不带 cmp；再加 noindex，同一份文本的另一种视图）
    useEffect(() => {
        if (!compareTarget.target) return;
        const m = document.createElement('meta');
        m.name = 'robots';
        m.content = 'noindex';
        document.head.appendChild(m);
        return () => m.remove();
    }, [compareTarget.target]);

    // ── 阅读功能一律写成阅读器插件（plugins/*），不再抓阅读器的 DOM ──
    // 取站点文案、反馈上下文的函数走 ref，插件对象就能保持引用稳定（阅读器在插件引用变时重算修饰）
    const live = useRef({ t, feedbackContext, openFeedback });
    live.current = { t, feedbackContext, openFeedback };
    // 校对模式（overview#605 D1.2）：开关为 null（没带 ?proof= 也没存过偏好）时校对插件不挂，页面与现状一致
    const proof = useProofPref();
    const proofStore = useMemo(() => createProofStore((v) => proofSet.current(v)), []);
    const proofSet = useRef(proof.set);
    proofSet.current = proof.set;
    useEffect(() => { proofStore.patch({ on: proof.on }); }, [proofStore, proof.on]);
    const reportPlg = useMemo(() => reportPlugin({
        getFeedbackContext: () => live.current.feedbackContext,
        openFeedback: (a) => live.current.openFeedback(a),
        getT: () => live.current.t,
    }), []);
    const proofPlg = useMemo(() => proofPlugin(proofStore), [proofStore]);
    const dataVersion = seed?.dataVersion ?? undefined;
    const downloadPlg = useMemo(() => downloadPlugin({ bookId: id, bookTitle, edition, dataVersion }), [id, bookTitle, edition, dataVersion]);
    const plugins = useMemo<ReaderPlugin[]>(
        () => [downloadPlg, versionChipPlugin, fontPlugin, reportPlg, fulltextPlugin, ...(proof.on !== null ? [proofPlg] : []), ...(comparePlugin ? [comparePlugin] : [])],
        [downloadPlg, reportPlg, proofPlg, comparePlugin, proof.on !== null], // eslint-disable-line react-hooks/exhaustive-deps
    );

    return (
        <>
        <ProofingNotice id={id} vol={meta?.proofVol} feedbackVol={meta?.feedbackVol} />
        {((sources && sources.length > 1) || siblings.length > 0) && (
            <TextSourceMenu
                currentId={id}
                rows={sources ?? []}
                compareId={compareTarget.target?.id ?? null}
                compareKey={compareTarget.target?.key ?? null}
                siblings={siblings}
                onCompare={(t) => compareTarget.setTarget(t)}
            />
        )}
        <div>
            <TextReader
                id={id}
                transport={transport}
                versionKey={sel.key ?? primary ?? 'default'}
                chapter={sel.chapter ?? null}
                onLocationChange={onLocationChange}
                anchor={urlAnchor}
                onNavigate={onNavigate}
                title={bookTitle}
                subtitle={edition ? <span data-testid="reader-edition">{convert(edition)}</span> : undefined}
                plugins={plugins}
                backHref="/read"
                onReportError={onReportError}
                textFileBase={TEXT_FILE_BASE}
                initialChapter={lead}
                hideSupersededVersions
                resolveFacsimile={loadFacsimile}
                onEntityNavigate={(target, e) => { e.preventDefault(); onNavigate(target); }}
            />
        </div>
        </>
    );
}

/** 阅读页客户端部分：站点页头 + 全宽阅读器（不套页面框、不要页脚） */
export default function ReaderClient(props: ReaderClientProps) {
    return (
        <BimLocaleProvider>
            <LayoutWrapper hideFooter>
                <Reader {...props} />
            </LayoutWrapper>
        </BimLocaleProvider>
    );
}
