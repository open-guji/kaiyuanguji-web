'use client';

import { useCallback, useEffect, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import LayoutWrapper from '@/components/layout/LayoutWrapper';
import { getTransport } from '@/lib/transport';
import { isLocalMode } from '@/lib/constants';
import {
    BookDetailLayout,
    type ExtraTab,
    type SourceLinkContext,
    type IndexEntry,
    type IndexDetailData,
} from 'book-index-ui';
import { useSource } from '@/components/common/SourceContext';
import BidLink from './BidLink';
import CitationBar from './CitationBar';
import DigitalizationView from './DigitalizationView';
import { buildSourceLinks } from '@/lib/repo-source';
import type { DigitalAssets } from '@/types';

interface BookDetailContentProps {
    id: string;
}

/** 详情数据 + 网站特有字段 */
type DetailWithAssets = IndexDetailData & {
    digital_assets?: DigitalAssets;
};

/** 本地模式下注入数字化资源信息（仅 has_digitalization: true 的条目） */
function enrichDigitalAssets(id: string, entry: IndexEntry, detail: DetailWithAssets): void {
    if (typeof window === 'undefined' || !isLocalMode) return;
    if (!(detail as unknown as Record<string, unknown>).has_digitalization) return;

    const pathParts = (entry.path || '').split('/');
    pathParts.pop();
    const baseDir = pathParts.join('/');
    const assetPath = baseDir ? `${baseDir}/${id}` : id;
    const basePath = `/local-data/${assetPath}`;

    detail.digital_assets = {
        image_manifest_url: `${basePath}/images/image_manifest.json`,
        tex_files: ['ce01.tex'],
    };
}

/** localhost 下走云端 feedback API（开发联调用），否则同源。 */
function resolveFeedbackUrl(): string {
    if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
        return 'https://www.kaiyuanguji.com/api/feedback';
    }
    return '/api/feedback';
}

export default function BookDetailContent({ id }: BookDetailContentProps) {
    const { source } = useSource();
    const router = useRouter();
    const searchParams = useSearchParams();

    const transport = useMemo(() => getTransport(source), [source]);

    // Draft → Production 重定向逻辑
    //   - 默认行为：若当前 id 是已升格的 draft，自动 replace 到 production id，
    //     同时把原 draft id 写到 ?redirected_from=...，给 banner 用。
    //   - 用户在 banner 上点「返回草稿」会跳到 ?id=<draft>&no_redirect=true，
    //     此时跳过自动 redirect，让用户看 tombstone 内容。
    const noRedirect = searchParams.get('no_redirect') === 'true';
    const redirectedFrom = searchParams.get('redirected_from');

    useEffect(() => {
        if (noRedirect) return;
        let cancelled = false;
        if (!transport.getEntry) return;
        transport.getEntry(id).then((entry) => {
            if (cancelled || !entry) return;
            const entryRedirectedFrom = (entry as { redirected_from?: string }).redirected_from;
            if (entryRedirectedFrom && entry.id && entry.id !== id) {
                const params = new URLSearchParams(searchParams.toString());
                params.set('id', entry.id);
                params.set('redirected_from', id);  // 当前 id 就是被升级的 draft id
                router.replace(`/book-index?${params.toString()}`, { scroll: false });
            }
        }).catch(() => { /* 静默：详情正常加载会自己报错 */ });
        return () => { cancelled = true; };
    }, [id, transport, router, searchParams, noRedirect]);

    const handleReturnToDraft = useCallback(() => {
        if (!redirectedFrom) return;
        const params = new URLSearchParams(searchParams.toString());
        params.set('id', redirectedFrom);
        params.delete('redirected_from');
        params.set('no_redirect', 'true');
        router.push(`/book-index?${params.toString()}`, { scroll: false });
    }, [redirectedFrom, router, searchParams]);

    const activeTab = searchParams.get('tab') || 'basic';
    const initialPage = parseInt(searchParams.get('page') || '1') || 1;
    const lineageMode = (searchParams.get('mode') === 'graph' ? 'graph' : 'list') as 'list' | 'graph';
    const lineageCollection = searchParams.get('collection') || undefined;
    const activeJuan = searchParams.get('juan');

    // ── URL 同步 ──
    const updateParams = useCallback((updater: (params: URLSearchParams) => void, replace = false) => {
        const params = new URLSearchParams(searchParams.toString());
        updater(params);
        params.set('id', id);
        const url = `/book-index?${params.toString()}`;
        if (replace) router.replace(url, { scroll: false });
        else router.push(url, { scroll: false });
    }, [router, searchParams, id]);

    const handleTabChange = useCallback((tab: string) => {
        updateParams((p) => {
            p.set('tab', tab);
            if (tab !== 'collated' && tab !== 'fulltext') {
                p.delete('juan');
            }
            if (tab === 'basic') {
                p.delete('page');
            }
            if (tab !== 'lineage') {
                p.delete('mode');
                p.delete('collection');
            }
        });
    }, [updateParams]);

    const handleJuanChange = useCallback((juan: string | null) => {
        updateParams((p) => {
            if (juan) p.set('juan', juan);
            else p.delete('juan');
            const cur = p.get('tab');
            if (cur !== 'collated' && cur !== 'fulltext') {
                p.set('tab', 'collated');
            }
        }, true);
    }, [updateParams]);

    const handleLineageModeChange = useCallback((mode: 'list' | 'graph') => {
        updateParams((p) => {
            if (mode === 'graph') p.set('mode', 'graph');
            else p.delete('mode');
            p.set('tab', 'lineage');
        }, true);
    }, [updateParams]);

    const handleLineageCollectionChange = useCallback((key: string) => {
        updateParams((p) => {
            if (key) p.set('collection', key);
            else p.delete('collection');
            p.set('tab', 'lineage');
        }, true);
    }, [updateParams]);

    const handleNavigate = useCallback((targetId: string) => {
        if (typeof window !== 'undefined') {
            window.location.href = `/book-index?id=${targetId}`;
        }
    }, []);

    const handleBack = useCallback(() => {
        router.push('/book-index');
    }, [router]);

    // ── 源文件链接解析 ──
    const getSourceLink = useCallback((ctx: SourceLinkContext) => {
        const links = buildSourceLinks(ctx.entry);
        if (ctx.activeTab === 'basic' || ctx.activeTab === 'emendated') return links.basic;
        if (ctx.activeTab === 'collated') {
            return ctx.activeJuan ? links.collatedJuan(ctx.activeJuan) : links.collatedDir;
        }
        if (ctx.activeTab === 'fulltext') {
            if (!ctx.activeJuan) return links.fullTextDir;
            // URL 里 juan 用 stem (e.g. "001")，GitHub 链接需要拼回 .md
            return links.fullTextChapter(`${ctx.activeJuan}.md`);
        }
        if (ctx.activeTab === 'lineage') return links.lineage;
        if (ctx.activeTab.startsWith('catalog:')) {
            const rid = ctx.activeTab.slice('catalog:'.length);
            if (rid === 'loading') return null;
            return links.catalog(rid);
        }
        return null;
    }, []);

    // ── 数字化 tab（kyg 特有，via extraTabs slot） ──
    const extraTabs: ExtraTab[] = useMemo(() => [
        {
            key: 'digital',
            label: '数字化',
            shouldShow: (detail) => !!(detail as DetailWithAssets).digital_assets,
            position: 'before-feedback',
            render: ({ detail }) => {
                const assets = (detail as DetailWithAssets).digital_assets;
                if (!assets) return null;
                return (
                    <div className="px-4 pb-8">
                        <DigitalizationView id={id} assets={assets} initialPage={initialPage} />
                    </div>
                );
            },
        },
    ], [id, initialPage]);

    // banner 高度从 BookDetailLayout 高度里扣，避免滚动条溢出
    //   - redirect banner（顶部）: 2rem（仅 redirected_from 时）
    //   - CitationBar（底部）:     1.5rem（始终占位，draft/production 都渲染）
    const bannerHeight = redirectedFrom ? '2rem' : '0px';
    const citationHeight = '1.5rem';
    const layoutHeight = `calc(100vh - 2.5rem - ${bannerHeight} - ${citationHeight})`;

    return (
        <LayoutWrapper hideFooter hideFeedbackButton>
            {redirectedFrom && (
                <div
                    role="status"
                    style={{ height: '2rem' }}
                    className="bg-amber-50 border-b border-amber-200 px-4 flex items-center justify-center gap-3 text-xs"
                >
                    <span className="text-amber-800">
                        已自动跳转到正式版本（原草稿 <code className="font-mono text-amber-700">{redirectedFrom}</code>）
                    </span>
                    <button
                        type="button"
                        onClick={handleReturnToDraft}
                        className="text-amber-700 hover:text-amber-900 underline underline-offset-2"
                    >
                        返回草稿
                    </button>
                </div>
            )}
            <BookDetailLayout
                id={id}
                transport={transport}
                activeTab={activeTab}
                onTabChange={handleTabChange}
                activeJuan={activeJuan}
                onJuanChange={handleJuanChange}
                lineageMode={lineageMode}
                onLineageModeChange={handleLineageModeChange}
                lineageCollection={lineageCollection}
                onLineageCollectionChange={handleLineageCollectionChange}
                initialPage={initialPage}
                onNavigate={handleNavigate}
                onBack={handleBack}
                backLabel="返回索引"
                renderLink={(linkId, label) => <BidLink id={linkId}>{label}</BidLink>}
                enrichDetail={(entry, detail) => enrichDigitalAssets(id, entry, detail as DetailWithAssets)}
                getSourceLink={getSourceLink}
                extraTabs={extraTabs}
                feedbackApiUrl={resolveFeedbackUrl}
                height={layoutHeight}
            />
            <CitationBar id={id} transport={transport} redirectedFrom={redirectedFrom} />
        </LayoutWrapper>
    );
}
