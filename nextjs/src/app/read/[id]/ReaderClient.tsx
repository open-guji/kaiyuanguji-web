'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { TextReader, createTextApi, useConvert, type ReaderReportContext, type TextLocation, type TextLocationCause } from 'book-index-ui';
import LayoutWrapper from '@/components/layout/LayoutWrapper';
import { useFeedback, useFeedbackPageContext } from '@/components/feedback/FeedbackProvider';
import SelectionReport from '@/components/feedback/SelectionReport';
import BimLocaleProvider from '@/components/common/BimLocaleProvider';
import { useSource } from '@/components/common/SourceContext';
import { getTransport } from '@/lib/transport';
import { SITE_NAME } from '@/lib/constants';
import { parseReaderSegments, readerPath, readerTitle, readerVersionName, splitReaderPathname, type ReaderSel } from '@/lib/reader-route';
import { readerFeedbackLabel } from '@/lib/feedback';
import { useSiteT } from '@/i18n/use-site-t';
import { seedTransport, type ReaderSeed } from './reader-seed';

interface ReaderClientProps {
    id: string;
    /** 服务端按地址落实的版本 key（缺省＝主版本）与章号；首帧照它渲染，与服务端 HTML 一致 */
    initial: ReaderSel;
    /** 书名，用于 <title> 与反馈上下文 */
    bookTitle: string;
    /** 服务端取好的首屏数据（manifest、版本目录、首章正文），见 reader-seed.ts；缺省则全由浏览器取 */
    seed?: ReaderSeed;
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
    const [meta, setMeta] = useState<{ at: string; versionLabel?: string; kind?: string; chapterTitle?: string } | null>(null);
    const at = `${id}|${sel.key ?? ''}|${sel.chapter ?? ''}`;
    useEffect(() => {
        let cancelled = false;
        (async () => {
            const manifest = await api.getManifest(id);
            const version = manifest?.versions.find((v) => v.key === (sel.key ?? 'default')) ?? manifest?.versions[0];
            if (!version) return;
            const index = sel.chapter ? await api.getIndex(id, version.key) : null;
            const title = index?.chapters.find((c) => c.file === sel.chapter)?.title?.trim();
            if (!cancelled) setMeta({ at, versionLabel: readerVersionName(version), kind: version.kind, chapterTitle: title || undefined });
        })().catch(() => {});
        return () => { cancelled = true; };
    }, [api, id, sel.key, sel.chapter, at]);
    return meta?.at === at ? meta : null;
}

function Reader({ id, initial, bookTitle, seed }: ReaderClientProps) {
    const router = useRouter();
    const { source } = useSource();
    const transport = useMemo(() => seedTransport(getTransport(source), seed?.calls), [source, seed]);
    const [sel, setSel] = useState<ReaderSel>(initial);

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

    const onLocationChange = useCallback((loc: TextLocation, cause: TextLocationCause) => {
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

    return (
        <div ref={textRef}>
            <TextReader
                id={id}
                transport={transport}
                versionKey={sel.key ?? 'default'}
                chapter={sel.chapter ?? null}
                onLocationChange={onLocationChange}
                onNavigate={onNavigate}
                title={bookTitle}
                backHref="/read"
                onReportError={onReportError}
            />
            <SelectionReport containerRef={textRef} context={feedbackContext} />
        </div>
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
