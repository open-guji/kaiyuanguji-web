'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { BookFullText, CollatedEdition, LocaleProvider, type ReaderReportContext, type WorkFullTextEntry } from 'book-index-ui';
import LayoutWrapper from '@/components/layout/LayoutWrapper';
import { useFeedback, useFeedbackPageContext } from '@/components/feedback/FeedbackProvider';
import SelectionReport from '@/components/feedback/SelectionReport';
import { useSource } from '@/components/common/SourceContext';
import { getTransport } from '@/lib/transport';
import { SITE_NAME } from '@/lib/constants';
import { parseItemId } from '@/lib/item-id';
import { collatedJuanFile, juanStem, parseReaderQuery, readerHref, readerTitle, type ReaderQuery } from '@/lib/reader-route';
import { readerFeedbackLabel } from '@/lib/feedback';
import { chapterKey, collatedJuanFiles, seedTransport, type ReaderSeed } from './reader-seed';

interface ReaderClientProps {
    id: string;
    /** 服务端按地址解析好的 kind／key／juan；首帧照它渲染，与服务端 HTML 一致 */
    initial: ReaderQuery;
    /** 书名，只用于翻卷后改 <title> */
    bookTitle: string;
    /** 服务端取好的首屏数据（全文清单、目录、首卷正文），见 reader-seed.ts；缺省则全由浏览器取 */
    seed?: ReaderSeed;
}

/**
 * 翻卷、换全文版本时同步地址栏、<title> 与 canonical，不整页刷新。
 * 用 history.pushState（Next 会同步到路由状态）而不是 router.push：
 * 后者对这个动态页会再请求一次服务端，没有必要。
 *
 * 每翻一卷留一条历史，按浏览器返回回到上一卷（overview#267 P2-3）；下面两种情况改用 replaceState：
 *   - 首帧：服务端给的地址与规范写法可能只差参数顺序，不该多出一条；
 *   - 阅读器自己补上第一卷（地址没带卷号、组件回报卷号）：这不是读者翻的，与上一条合并。
 */
function syncLocation(id: string, q: ReaderQuery, bookTitle: string, opts: { push: boolean; updateCanonical: boolean; chapterTitle?: string }) {
    const href = readerHref(id, q);
    if (window.location.pathname + window.location.search !== href) {
        if (opts.push) window.history.pushState(window.history.state, '', href);
        else window.history.replaceState(window.history.state, '', href);
    }
    document.title = `${readerTitle(bookTitle, q, opts.chapterTitle)} - ${SITE_NAME}`;
    const canonical = opts.updateCanonical ? document.querySelector<HTMLLinkElement>('link[rel="canonical"]') : null;
    if (canonical) canonical.href = new URL(href, canonical.href).href;
}

/** 两个阅读页状态是否同一处（地址回退时判断要不要跟着改） */
function sameQuery(a: ReaderQuery, b: ReaderQuery): boolean {
    return a.kind === b.kind && (a.key ?? '') === (b.key ?? '') && (a.juan ?? '') === (b.juan ?? '');
}

/**
 * 全文目录里的章名（红楼梦这类以「回」分章的书，<title> 写「第三回」而不是「卷3」）。
 * 服务端给了这一份的目录就直接用，否则在浏览器取一次；取不到就没有，回落「卷N」。
 */
function useChapterTitles(
    id: string,
    kind: ReaderQuery['kind'],
    key: string | undefined,
    isWork: boolean,
    transport: ReturnType<typeof getTransport>,
    seedIndex: ReaderSeed['fullTextIndex'],
): Map<string, string> | null {
    const [fetched, setFetched] = useState<{ at: string; map: Map<string, string> } | null>(null);
    const at = `${id}|${key ?? ''}`;
    useEffect(() => {
        if (kind !== 'fulltext' || seedIndex || (isWork && !key)) return;
        let cancelled = false;
        const load = isWork
            ? transport.getWorkFullTextIndex?.(id, key!)
            : transport.getBookFullTextIndex?.(id);
        (load ?? Promise.resolve(null))
            .then((index) => { if (!cancelled && index) setFetched({ at, map: chapterTitleMap(index) }); })
            .catch(() => {});
        return () => { cancelled = true; };
    }, [id, kind, key, isWork, transport, seedIndex, at]);
    return useMemo(() => {
        if (kind !== 'fulltext') return null;
        if (seedIndex) return chapterTitleMap(seedIndex);
        return fetched?.at === at ? fetched.map : null;
    }, [kind, seedIndex, fetched, at]);
}

function chapterTitleMap(index: { chapters?: { file?: string; title?: string }[] }): Map<string, string> {
    const m = new Map<string, string>();
    for (const c of Array.isArray(index.chapters) ? index.chapters : []) {
        if (typeof c?.file === 'string' && typeof c.title === 'string' && c.title.trim()) m.set(chapterKey(c.file), c.title.trim());
    }
    return m;
}

/** Work 全文：先取清单，key 缺省取首选那份（与 BookDetailLayout 同一规则）。服务端给了清单就不再取 */
function useWorkFullTexts(id: string, enabled: boolean, transport: ReturnType<typeof getTransport>, seeded?: WorkFullTextEntry[]) {
    const [list, setList] = useState<WorkFullTextEntry[] | null>(seeded ?? null);
    useEffect(() => {
        if (!enabled || seeded) return;
        let cancelled = false;
        const get = transport.getWorkFullTextList?.bind(transport);
        (get ? get(id) : Promise.resolve([] as WorkFullTextEntry[]))
            .then((l) => { if (!cancelled) setList((l ?? []).filter((v) => v.owner_type !== 'Book')); })
            .catch(() => { if (!cancelled) setList([]); });
        return () => { cancelled = true; };
    }, [id, enabled, transport, seeded]);
    return list;
}

function Muted({ children }: { children: React.ReactNode }) {
    return <div style={{ padding: 24, color: 'var(--bim-desc-fg)' }}>{children}</div>;
}

function Reader({ id, initial, bookTitle, seed }: ReaderClientProps) {
    const router = useRouter();
    const { source } = useSource();
    const transport = useMemo(() => seedTransport(getTransport(source), seed?.calls), [source, seed]);
    const [q, setQ] = useState<ReaderQuery>(initial);
    const isWork = parseItemId(id)?.type === 'work';

    // 浏览器前进／后退：地址变了而状态没变（我们自己 pushState 的不算，那时两者已一致），状态跟着地址走
    // 首帧不查（服务端已按地址渲染），只在查询串之后变了才跟
    const searchParams = useSearchParams();
    const spKey = searchParams.toString();
    const seenSp = useRef(spKey);
    useEffect(() => {
        if (seenSp.current === spKey) return;
        seenSp.current = spKey;
        const fromUrl = parseReaderQuery(id, new URLSearchParams(spKey));
        if (fromUrl) setQ((prev) => (sameQuery(prev, fromUrl) ? prev : fromUrl));
    }, [id, spKey]);

    const workTexts = useWorkFullTexts(id, q.kind === 'fulltext' && isWork, transport, seed?.workTexts);
    // Work 全文实际渲染的是哪一份（与下面渲染处同一规则）；清单没到之前不知道
    const workKey = workTexts
        ? (q.key && workTexts.some((v) => v.key === q.key) ? q.key : (workTexts.find((v) => v.primary) ?? workTexts[0])?.key)
        : undefined;
    const seedIndex = q.kind !== 'fulltext' ? undefined : isWork ? (workKey === seed?.key ? seed?.fullTextIndex : undefined) : seed?.fullTextIndex;
    const chapterTitles = useChapterTitles(id, q.kind, isWork ? workKey : '', isWork, transport, seedIndex);
    const chapterTitle = q.juan ? chapterTitles?.get(chapterKey(q.juan)) : undefined;

    // 首帧的 canonical 以服务端为准（卷号查不准时它会回落到不带卷号的地址），之后翻卷再跟着改。
    // 翻卷留历史（push）；阅读器补第一卷（上一状态没有卷号）与首帧一样只 replace
    const synced = useRef(false);
    const prevQ = useRef<ReaderQuery>(initial);
    useEffect(() => {
        const prev = prevQ.current;
        prevQ.current = q;
        syncLocation(id, q, bookTitle, {
            push: synced.current && !(prev.juan === undefined && q.juan !== undefined && prev.kind === q.kind && (prev.key ?? '') === (q.key ?? '')),
            updateCanonical: synced.current,
            chapterTitle,
        });
        synced.current = true;
    }, [id, q, bookTitle, chapterTitle]);

    // 整理本组件用卷文件名（juan/011.json），地址与本页状态用短形式（011）
    const collatedFiles = useMemo(() => (seed?.collatedIndex ? collatedJuanFiles(seed.collatedIndex) : undefined), [seed]);
    const onJuanChange = useCallback((juan: string | null) => {
        const next = juan == null ? undefined : q.kind === 'collated' ? juanStem(juan) : juan;
        setQ((prev) => (prev.juan === next ? prev : { ...prev, juan: next }));
    }, [q.kind]);
    const onVersionChange = useCallback((key: string) => {
        setQ((prev) => ({ kind: prev.kind, key }));
    }, []);
    const onNavigate = useCallback((target: string) => router.push(`/item/${target}`), [router]);

    // N7：本页反馈上下文（书名 · 整理本/全文 · 卷），导航栏「反馈」和选字「报错」都带上；卷号另随 pageUrl 提交
    const feedbackContext = useMemo(
        () => ({ resourceId: id, label: readerFeedbackLabel(bookTitle, q) }),
        [id, bookTitle, q],
    );
    useFeedbackPageContext(feedbackContext);
    // v4 P2：阅读器右栏「报告错字」→ 同一个反馈弹窗，带上书名、条目 id、卷、位置锚点与选中文字
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

    const renderReader = () => {
        if (q.kind === 'collated') {
            return (
                <CollatedEdition
                    index={seed?.collatedIndex}
                    workId={id}
                    transport={transport}
                    onNavigate={onNavigate}
                    activeJuan={q.juan ? collatedJuanFile(q.juan, collatedFiles) : null}
                    onJuanChange={onJuanChange}
                    onReportError={onReportError}
                />
            );
        }

        if (isWork) {
            if (!workTexts) return <Muted>加载全文目录…</Muted>;
            const key = workKey;
            if (!key) return <Muted>暂无全文</Muted>;
            return (
                <BookFullText
                    key={key}
                    index={key === seed?.key ? seed?.fullTextIndex : undefined}
                    bookId={id}
                    workKey={key}
                    versions={workTexts}
                    onVersionChange={onVersionChange}
                    transport={transport}
                    activeChapter={q.juan ?? null}
                    onChapterChange={onJuanChange}
                    onReportError={onReportError}
                />
            );
        }

        return (
            <BookFullText
                index={seed?.fullTextIndex}
                bookId={id}
                transport={transport}
                activeChapter={q.juan ?? null}
                onChapterChange={onJuanChange}
                onReportError={onReportError}
            />
        );
    };

    return (
        <div ref={textRef}>
            {renderReader()}
            <SelectionReport containerRef={textRef} context={feedbackContext} />
        </div>
    );
}

/** 阅读页客户端部分：站点页头 + 全宽阅读器（不套页面框、不要页脚） */
export default function ReaderClient(props: ReaderClientProps) {
    return (
        <LocaleProvider>
            <LayoutWrapper hideFooter>
                <Reader {...props} />
            </LayoutWrapper>
        </LocaleProvider>
    );
}
