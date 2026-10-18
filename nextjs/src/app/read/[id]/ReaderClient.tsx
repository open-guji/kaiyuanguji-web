'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { TextReader, createTextApi, useConvert, adaptCharCord, adaptPunctJson, iiifVolumeOf, type ReaderReportContext, type ReaderResolveContext, type TextLocation, type TextLocationCause } from 'book-index-ui';
import LayoutWrapper from '@/components/layout/LayoutWrapper';
import { useFeedback, useFeedbackPageContext } from '@/components/feedback/FeedbackProvider';
import SelectionReport from '@/components/feedback/SelectionReport';
import BimLocaleProvider from '@/components/common/BimLocaleProvider';
import { useSource } from '@/components/common/SourceContext';
import { getTransport } from '@/lib/transport';
import { isProofingChapter } from '@/lib/proofing';
import ProofingNotice from './ProofingNotice';
import CharFixEntry from '@/components/CharFixEntry';
import { collectChars, collectEntities, entityFileVersion, VERSION_RE, type CharFixCtx } from '@/lib/charfix';
import { readerManifest } from '@/lib/reader-manifest';
import { loadFacsimile } from '@/lib/facsimile';
import { loadDuiduFiles } from '@/lib/duidu-data';
import { SITE_NAME } from '@/lib/constants';
import { parseReaderSegments, readerPath, readerTitle, readerVersionName, splitReaderPathname, type ReaderSel } from '@/lib/reader-route';
import { readerFeedbackLabel } from '@/lib/feedback';
import { useSiteT } from '@/i18n/use-site-t';
import { seedCallKey, seedTransport, type ReaderSeed } from './reader-seed';
import ReaderLead, { type ReaderLeadData } from './ReaderLead';
import ReaderFulltextHint from '@/components/fulltext/ReaderFulltextHint';
import ReaderProof, { useProofPref } from './ReaderProof';
import { emptyProofLayer, loadProofLayer, type ProofLayer } from '@/lib/proof';

interface ReaderClientProps {
    id: string;
    /** 服务端按地址落实的版本 key（缺省＝主版本）与章号；首帧照它渲染，与服务端 HTML 一致 */
    initial: ReaderSel;
    /** 书名，用于 <title> 与反馈上下文 */
    bookTitle: string;
    /** 服务端取好的首屏数据（manifest、版本目录、首章正文），见 reader-seed.ts；缺省则全由浏览器取 */
    seed?: ReaderSeed;
    /** 服务端直出的首章正文＋上下章链接（给爬虫看的同一章正文），阅读器内容出来后卸载；见 ReaderLead.tsx */
    lead?: ReaderLeadData;
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
function syncLocation(id: string, sel: ReaderSel, title: string, opts: { push: boolean; updateCanonical: boolean }) {
    const href = readerPath(id, sel);
    if (window.location.pathname !== href) {
        if (opts.push) window.history.pushState(window.history.state, '', href);
        else window.history.replaceState(window.history.state, '', href);
    }
    document.title = `${title} - ${SITE_NAME}`;
    const canonical = opts.updateCanonical ? document.querySelector<HTMLLinkElement>('link[rel="canonical"]') : null;
    if (canonical) canonical.href = new URL(href, canonical.href).href;
}

const sameSel = (a: ReaderSel, b: ReaderSel) => (a.key ?? '') === (b.key ?? '') && (a.chapter ?? '') === (b.chapter ?? '');

/** 版本名与章名（<title>、反馈上下文用）：取 manifest 与版本目录，服务端给了种子就不发请求；取不到就没有 */
function useTextMeta(id: string, sel: ReaderSel, transport: ReturnType<typeof getTransport>) {
    const api = useMemo(() => createTextApi(transport), [transport]);
    const [meta, setMeta] = useState<{ at: string; versionLabel?: string; kind?: string; chapterTitle?: string; proofVol?: string } | null>(null);
    const at = `${id}|${sel.key ?? ''}|${sel.chapter ?? ''}`;
    useEffect(() => {
        let cancelled = false;
        (async () => {
            const manifest = await api.getManifest(id);
            const version = manifest?.versions.find((v) => v.key === (sel.key ?? 'default')) ?? manifest?.versions[0];
            if (!version) return;
            const index = await api.getIndex(id, version.key);
            const chapter = index?.chapters.find((c) => (sel.chapter ? c.file === sel.chapter : true));
            const title = sel.chapter ? chapter?.title?.trim() : undefined;
            // 本册开着校对：精校页入口（只读章条目上的 proofing，见 lib/proofing.ts）
            const proofVol = isProofingChapter(chapter) && chapter?.file ? chapter.file.replace(/\.[^.]+$/, '') : undefined;
            if (!cancelled) setMeta({ at, versionLabel: readerVersionName(version), kind: version.kind, chapterTitle: title || undefined, proofVol });
        })().catch(() => {});
        return () => { cancelled = true; };
    }, [api, id, sel.key, sel.chapter, at]);
    return meta?.at === at ? meta : null;
}

/** 浏览器端自己取的 manifest 也按阅读页规则过一遍（服务端种子已过，见 lib/reader-manifest.ts；重复处理无副作用） */
function readerTransport<T extends ReturnType<typeof getTransport>>(transport: T): T {
    return new Proxy(transport, {
        get(target, prop, receiver) {
            const orig = Reflect.get(target, prop, receiver);
            if (prop !== 'getTextManifest' || typeof orig !== 'function') return orig;
            return async (...args: unknown[]) => {
                const m = await (orig as (...a: unknown[]) => Promise<any>).apply(target, args);
                return m && Array.isArray(m.versions) ? readerManifest(m) : m;
            };
        },
    });
}

/** 主版本 key：阅读页 manifest 里有 default 就是它，否则（目录型 default 被隐藏，overview#456）是第一份版本 */
function primaryKeyOf(m: unknown): string | null {
    const versions = (m as { versions?: { key?: string }[] } | null | undefined)?.versions;
    if (!Array.isArray(versions) || versions.length === 0) return null;
    return versions.find((v) => v.key === 'default')?.key ?? versions[0].key ?? null;
}

/** 「改字」上下文里的专名层（GUJI-590）；本章还没取到／没有时是 NO_ENT */
type CharfixEnt = Pick<CharFixCtx, 'entities' | 'entityVersion'>;
const NO_ENT: CharfixEnt = { entities: [], entityVersion: '' };

function Reader({ id, initial, bookTitle, seed, lead }: ReaderClientProps) {
    const router = useRouter();
    const { source } = useSource();
    const transport = useMemo(() => readerTransport(seedTransport(getTransport(source), seed?.calls)), [source, seed]);
    const [sel, setSel] = useState<ReaderSel>(initial);
    // 受控的版本 key 必须是 manifest 里真有的：服务端种子里有 manifest 就同步算出（正常路径）；
    // 没有（预取超时、失败）先按 default 挂阅读器，浏览器取到 manifest 后若主版本不是 default（目录型 default 被隐藏）再换过去
    const [primary, setPrimary] = useState<string | null>(() => primaryKeyOf(seed?.calls?.[seedCallKey('getTextManifest', id)]));
    useEffect(() => {
        if (primary !== null) return;
        let cancelled = false;
        (async () => primaryKeyOf(await (transport as { getTextManifest: (id: string) => Promise<unknown> }).getTextManifest(id)))()
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

    // 首帧的 canonical 以服务端为准（章号查不准时它会回落到不带章号的地址），之后翻章再跟着改。
    const synced = useRef(false);
    const pushNext = useRef(false);
    // 书名、版本名是数据，按繁简偏好转（useConvert）；<title> 挂载后跟随读者的繁简选择（overview#337）
    const { convert } = useConvert();
    useEffect(() => {
        syncLocation(id, sel, convert(readerTitle(bookTitle, sel.chapter, meta?.chapterTitle, meta?.versionLabel)), {
            push: synced.current && pushNext.current,
            updateCanonical: synced.current,
        });
        pushNext.current = false;
        synced.current = true;
    }, [id, sel, bookTitle, meta, convert]);

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
    // v4 P2：阅读器右栏「报告错字」→ 同一个反馈弹窗，带上书名、条目 id、章、位置锚点与选中文字
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
    const textRef = useRef<HTMLDivElement>(null);
    // 「改字」入口用的本章上下文（GUJI-561）：对读数据与专名取到时顺手记；key＝章，换章后旧的不沿用。
    // 两路（对读、专名）先后不定：专名先到就先存在 ent 里，对读到了再并进 ctx
    const charfix = useRef<{ key: string; ctx: CharFixCtx | null; ent: CharfixEnt }>({ key: '', ctx: null, ent: NO_ENT });
    const getCharfixCtx = useCallback(() => charfix.current.ctx, []);

    // 校对模式（overview#605 D1.2）：开关为 null（没带 ?proof= 也没存过偏好）时下面一切都不动，DOM 与现状一致。
    // 只在开着时才取 proof_file；章上下文（含 proof_file 声明）在 resolveWarpData 里顺手记下
    const proof = useProofPref();
    const proofOnRef = useRef(false);
    proofOnRef.current = proof.on === true;
    const proofCtx = useRef<{ ctx: ReaderResolveContext | undefined; key: string } | null>(null);
    const [proofLayer, setProofLayer] = useState<ProofLayer>(() => emptyProofLayer());
    const fetchProof = useCallback((ctx: ReaderResolveContext | undefined) => {
        loadProofLayer(id, ctx, transport as { getTextFile?: (id: string, key: string, file: string) => Promise<unknown> }).then(setProofLayer);
    }, [id, transport]);
    useEffect(() => {
        if (proof.on === true && proofCtx.current) fetchProof(proofCtx.current.ctx);
        if (proof.on !== true) setProofLayer(prev => (prev.cells.size === 0 ? prev : emptyProofLayer()));
    }, [proof.on, fetchProof]);

    // 对读（图文对读）：章条目声明了 `char_file` 就按声明取 char（再加 `punct_file`、`entity_file`、`norm_file`）；
    // 有 `cord_file` 才有像素框，两边按格位对上做对读版面；没有 cord 就不做对读版面、不画书影格线（见 lib/duidu-data.ts）。
    const resolveWarpData = useCallback(async (chapterKey: string, ctx?: ReaderResolveContext) => {
        proofCtx.current = { ctx, key: chapterKey };
        if (proofOnRef.current) fetchProof(ctx);
        const files = await loadDuiduFiles(id, ctx, chapterKey, transport);
        if (!files?.cord) return null;
        // 规范层（norm.json）：人审过的「异体→通行字」，按格位 key 挂到字上；没声明或取不到时 files.norm 为 null＝与改前一致
        const pages = adaptCharCord(files.char, files.cord, files.norm);
        if (pages.length === 0) return null;
        const chapterFile = ctx?.chapter?.file;
        // 文本版本：章条目的 text_version，缺则 char.json 的 version；两处都没有（或不合口径）就是空串——不猜，改字入口照出但不收（浮条里说明）
        const textVersion = [ctx?.chapter?.text_version, (files.char as { version?: unknown } | null)?.version]
            .map((v) => (v === undefined || v === null ? '' : String(v)))
            .find((v) => VERSION_RE.test(v)) ?? '';
        const ent = charfix.current.key === chapterKey ? charfix.current.ent : NO_ENT;
        charfix.current = {
            key: chapterKey,
            ent,
            ctx: {
                book: id,
                volume: String(chapterFile ?? chapterKey),
                chapter: String(chapterKey),
                textVersion,
                chars: collectChars(pages),
                ...ent,
            },
        };
        const vol = iiifVolumeOf(files.cord);
        // 卷二第 10 页有手工透视矫正（含版心与对偶页拼接）的样张，别的页走逐字坐标平铺
        let base: Record<string, any> = { page_id: '', title: '', image_size: [0, 0], total_warped_w: 0, columns: [] };
        if (id === '96mid1ogzk' && vol?.vol === '02' && pages.some(p => p.page === 10)) {
            try {
                const res10 = await fetch('/fixtures/vol02_p10.json');
                if (res10.ok) {
                    base = await res10.json();
                    // 对偶页（第 9 叶）与第 10 叶同样改读 COS 原图档
                    const mate = await loadFacsimile(vol.bookId, vol.vol);
                    const mateImg = mate?.find(m => m.pageNo === 9);
                    if (mateImg?.hiresUrl && base.banxin) base = { ...base, banxin: { ...base.banxin, mate_image_url: mateImg.hiresUrl } };
                }
            } catch { /* 样张取不到就全部平铺 */ }
        }
        // hasNorm：章条目声明了 norm_file 且取到了（哪怕是空表）＝自校文本，阅读器的「原字」档可选；外来文本没有，置灰（overview#540）
        return { ...base, pages, punctuations: adaptPunctJson(files.punct), hasNorm: files.norm != null } as any;
    }, [id, transport, fetchProof]);

    // 实体标注（open-guji-cv entity_extract 的 entity.json，须带逐字 anchor）；没有就不画
    const resolveEntities = useCallback(async (chapterKey: string, ctx?: ReaderResolveContext) => {
        const entity = (await loadDuiduFiles(id, ctx, chapterKey, transport))?.entity ?? null;
        const declared = ctx?.chapter?.entity_version;
        const ent = {
            entities: collectEntities(entity),
            // 专名层版本：章条目的 entity_version，缺则 entity.json 的 version；都没有就不出「专名有误」
            entityVersion: typeof declared === 'string' && VERSION_RE.test(declared) ? declared : entityFileVersion(entity),
        };
        if (charfix.current.key === chapterKey && charfix.current.ctx) charfix.current = { ...charfix.current, ent, ctx: { ...charfix.current.ctx, ...ent } };
        else charfix.current = { key: chapterKey, ctx: null, ent };
        return entity;
    }, [id, transport]);

    // 书影来自 COS 的 IIIF manifest：册号从 cord 里各页的 canvas id 取（页码对照见 lib/facsimile.ts）
    const resolveImages = useCallback(async (chapterKey: string, ctx?: ReaderResolveContext) => {
        const files = await loadDuiduFiles(id, ctx, chapterKey, transport);
        const vol = files?.cord ? iiifVolumeOf(files.cord) : null;
        return vol ? loadFacsimile(vol.bookId, vol.vol) : null;
    }, [id, transport]);

    return (
        <>
        <ProofingNotice id={id} vol={meta?.proofVol} />
        <div ref={textRef}>
            <TextReader
                id={id}
                transport={transport}
                versionKey={sel.key ?? primary ?? 'default'}
                chapter={sel.chapter ?? null}
                onLocationChange={onLocationChange}
                onNavigate={onNavigate}
                title={bookTitle}
                backHref="/read"
                onReportError={onReportError}
                resolveWarpData={resolveWarpData}
                resolveImages={resolveImages}
                resolveEntities={resolveEntities}
                onEntityNavigate={(target, e) => { e.preventDefault(); onNavigate(target); }}
            />
            {lead && <ReaderLead data={lead} hostRef={textRef} />}
            <SelectionReport containerRef={textRef} context={feedbackContext} />
            <CharFixEntry containerRef={textRef} getCtx={getCharfixCtx} />
            {proof.on !== null && <ReaderProof layer={proofLayer} hostRef={textRef} on={proof.on} onToggle={proof.set} />}
        </div>
        {/* 全文搜索定位（GUJI-163 / F6 步 4）：只在地址带 ?ft= 时工作；放在 textRef 之外，提示文字不被当成命中 */}
        <ReaderFulltextHint hostRef={textRef} chapter={sel.chapter} />
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
