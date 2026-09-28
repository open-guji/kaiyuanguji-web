'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { BookFullText, CollatedEdition, LocaleProvider, type WorkFullTextEntry } from 'book-index-ui';
import LayoutWrapper from '@/components/layout/LayoutWrapper';
import { useFeedbackPageContext } from '@/components/feedback/FeedbackProvider';
import SelectionReport from '@/components/feedback/SelectionReport';
import { useSource } from '@/components/common/SourceContext';
import { getTransport } from '@/lib/transport';
import { SITE_NAME } from '@/lib/constants';
import { parseItemId } from '@/lib/item-id';
import { readerHref, readerTitle, type ReaderQuery } from '@/lib/reader-route';
import { readerFeedbackLabel } from '@/lib/feedback';
import { seedTransport, type ReaderSeed } from './reader-seed';

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
 * 用 history.replaceState（Next 会同步到路由状态）而不是 router.replace：
 * 后者对这个动态页会再请求一次服务端，没有必要；与旧详情页一样用 replace，不给每一卷留一条历史。
 */
function syncLocation(id: string, q: ReaderQuery, bookTitle: string, updateCanonical: boolean) {
    const href = readerHref(id, q);
    if (window.location.pathname + window.location.search !== href) {
        window.history.replaceState(window.history.state, '', href);
    }
    document.title = `${readerTitle(bookTitle, q)} - ${SITE_NAME}`;
    const canonical = updateCanonical ? document.querySelector<HTMLLinkElement>('link[rel="canonical"]') : null;
    if (canonical) canonical.href = new URL(href, canonical.href).href;
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

    // 首帧的 canonical 以服务端为准（卷号查不准时它会回落到不带卷号的地址），之后翻卷再跟着改
    const synced = useRef(false);
    useEffect(() => {
        syncLocation(id, q, bookTitle, synced.current);
        synced.current = true;
    }, [id, q, bookTitle]);

    const onJuanChange = useCallback((juan: string | null) => {
        setQ((prev) => (prev.juan === (juan ?? undefined) ? prev : { ...prev, juan: juan ?? undefined }));
    }, []);
    const onVersionChange = useCallback((key: string) => {
        setQ((prev) => ({ kind: prev.kind, key }));
    }, []);
    const onNavigate = useCallback((target: string) => router.push(`/item/${target}`), [router]);

    const isWork = parseItemId(id)?.type === 'work';
    const workTexts = useWorkFullTexts(id, q.kind === 'fulltext' && isWork, transport, seed?.workTexts);

    // N7：本页反馈上下文（书名 · 整理本/全文 · 卷），导航栏「反馈」和选字「报错」都带上；卷号另随 pageUrl 提交
    const feedbackContext = useMemo(
        () => ({ resourceId: id, label: readerFeedbackLabel(bookTitle, q) }),
        [id, bookTitle, q],
    );
    useFeedbackPageContext(feedbackContext);
    const textRef = useRef<HTMLDivElement>(null);

    return (
        <div ref={textRef}>
            <ReaderBody id={id} q={q} isWork={isWork} workTexts={workTexts} seed={seed} transport={transport}
                onNavigate={onNavigate} onJuanChange={onJuanChange} onVersionChange={onVersionChange} />
            <SelectionReport containerRef={textRef} context={feedbackContext} />
        </div>
    );
}

interface ReaderBodyProps {
    id: string;
    q: ReaderQuery;
    isWork: boolean;
    workTexts: WorkFullTextEntry[] | null;
    seed?: ReaderSeed;
    transport: ReturnType<typeof getTransport>;
    onNavigate: (target: string) => void;
    onJuanChange: (juan: string | null) => void;
    onVersionChange: (key: string) => void;
}

function ReaderBody({ id, q, isWork, workTexts, seed, transport, onNavigate, onJuanChange, onVersionChange }: ReaderBodyProps) {
    if (q.kind === 'collated') {
        return (
            <CollatedEdition
                index={seed?.collatedIndex}
                workId={id}
                transport={transport}
                onNavigate={onNavigate}
                activeJuan={q.juan ?? null}
                onJuanChange={onJuanChange}
            />
        );
    }

    if (isWork) {
        if (!workTexts) return <Muted>加载全文目录…</Muted>;
        const key = q.key && workTexts.some((v) => v.key === q.key)
            ? q.key
            : (workTexts.find((v) => v.primary) ?? workTexts[0])?.key;
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
        />
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
