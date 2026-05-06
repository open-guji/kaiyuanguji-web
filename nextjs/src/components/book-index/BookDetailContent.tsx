'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import LayoutWrapper from '@/components/layout/LayoutWrapper';
import { getTransport } from '@/lib/transport';
import { isLocalMode } from '@/lib/constants';
import { IndexView, CollectionCatalog, CollatedEdition, EmendatedBySection, LocaleToggle, VersionLineageView, useConvert, buildLineageGraph } from 'book-index-ui';
import type { IndexEntry, IndexDetailData, ResourceCatalog, CollatedEditionIndex, LineageGraph, WorkDetailData, BookDetailData } from 'book-index-ui';
import { useSource } from '@/components/common/SourceContext';
import { notFound, useRouter, useSearchParams } from 'next/navigation';
import BidLink from './BidLink';
import DigitalizationView from './DigitalizationView';
import FeedbackTab from './FeedbackTab';
import type { DigitalAssets } from '@/types';

type TabType = 'basic' | 'digital' | 'collated' | 'emendated' | 'lineage' | 'feedback' | `catalog:${string}`;

interface BookDetailContentProps {
    id: string;
}

/** 详情数据 + 网站特有字段 */
type DetailWithAssets = IndexDetailData & {
    digital_assets?: DigitalAssets;
    version_graph?: any;
    books?: string[];
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

interface NavItem {
    key: TabType;
    label: string;
}

function SideNav({ items, activeKey, onSelect }: {
    items: NavItem[];
    activeKey: string;
    onSelect: (key: TabType) => void;
}) {
    return (
        <nav className="flex flex-col pt-4">
            {/* 返回索引 */}
            <Link
                href="/book-index"
                className="flex items-center gap-1.5 px-5 py-2 text-sm text-ink hover:text-vermilion transition-colors"
            >
                <svg className="w-3.5 h-3.5" fill="none" strokeWidth="2" viewBox="0 0 24 24" stroke="currentColor">
                    <path d="M15 19l-7-7 7-7" />
                </svg>
                返回索引
            </Link>

            <div className="my-2 mx-4 border-t border-border/30" />

            {/* 导航项 */}
            {items.map(item => {
                const isActive = item.key === activeKey;
                return (
                    <button
                        key={item.key}
                        onClick={() => onSelect(item.key)}
                        className={`text-left px-5 py-2 text-sm transition-colors relative ${
                            isActive
                                ? 'text-vermilion font-medium'
                                : 'text-ink hover:text-vermilion'
                        }`}
                    >
                        {isActive && (
                            <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-4 bg-vermilion rounded-r" />
                        )}
                        {item.label}
                    </button>
                );
            })}
        </nav>
    );
}

function TopNav({ items, activeKey, onSelect }: {
    items: NavItem[];
    activeKey: string;
    onSelect: (key: TabType) => void;
}) {
    return (
        <div className="flex-shrink-0 border-b border-border/30 bg-paper">
            {/* 返回 + tab 同行 */}
            <div className="flex items-center overflow-x-auto">
                <Link
                    href="/book-index"
                    className="flex items-center gap-1 px-3 py-2.5 text-sm text-ink hover:text-vermilion transition-colors flex-shrink-0 border-r border-border/30"
                >
                    <svg className="w-3.5 h-3.5" fill="none" strokeWidth="2" viewBox="0 0 24 24" stroke="currentColor">
                        <path d="M15 19l-7-7 7-7" />
                    </svg>
                    返回
                </Link>
                {items.map(item => {
                    const isActive = item.key === activeKey;
                    return (
                        <button
                            key={item.key}
                            onClick={() => onSelect(item.key)}
                            className={`px-4 py-2.5 text-sm transition-colors flex-shrink-0 border-b-2 ${
                                isActive
                                    ? 'text-vermilion font-medium border-vermilion'
                                    : 'text-ink hover:text-vermilion border-transparent'
                            }`}
                        >
                            {item.label}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

/** 点击关联条目：跳转到对应详情页 */
function handleNavigate(targetId: string) {
    window.location.href = `/book-index?id=${targetId}`;
}

export default function BookDetailContent({ id }: BookDetailContentProps) {
    const { source } = useSource();
    const router = useRouter();
    const searchParams = useSearchParams();
    const { convert } = useConvert();

    const [entry, setEntry] = useState<IndexEntry | null>(null);
    const [detail, setDetail] = useState<DetailWithAssets | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // 丛编目录
    const [catalogList, setCatalogList] = useState<ResourceCatalog[]>([]);
    const [catalogLoading, setCatalogLoading] = useState(false);
    // 整理本（卷结构）
    const [collatedIndex, setCollatedIndex] = useState<CollatedEditionIndex | null>(null);
    const [collatedLoading, setCollatedLoading] = useState(false);
    // 版本传承图
    const [lineageGraph, setLineageGraph] = useState<LineageGraph | null>(null);
    const [lineageLoading, setLineageLoading] = useState(false);
    // 用于客户端切换 collection 时按需重建 graph（getLineageGraph 命中时仍保留以做切换）
    const [lineageWork, setLineageWork] = useState<WorkDetailData | null>(null);
    const [lineageBooks, setLineageBooks] = useState<BookDetailData[]>([]);

    const activeTab = (searchParams.get('tab') || 'basic') as TabType;
    const initialPage = parseInt(searchParams.get('page') || '1') || 1;
    const lineageMode = (searchParams.get('mode') === 'graph' ? 'graph' : 'list') as 'list' | 'graph';
    const lineageCollection = searchParams.get('collection') || undefined;

    const setActiveTab = (tab: TabType) => {
        const params = new URLSearchParams(searchParams.toString());
        params.set('tab', tab);
        if (tab === 'basic') {
            params.delete('page');
        }
        params.set('id', id);
        router.push(`/book-index?${params.toString()}`, { scroll: false });
    };

    const handleLineageModeChange = (newMode: 'list' | 'graph') => {
        const params = new URLSearchParams(searchParams.toString());
        if (newMode === 'graph') {
            params.set('mode', 'graph');
        } else {
            params.delete('mode');
        }
        params.set('id', id);
        router.replace(`/book-index?${params.toString()}`, { scroll: false });
    };

    const handleLineageCollectionChange = (key: string) => {
        const params = new URLSearchParams(searchParams.toString());
        const defaultKey = lineageWork?.version_graph?.default_collection;
        if (key && key !== defaultKey) {
            params.set('collection', key);
        } else {
            params.delete('collection');
        }
        params.set('id', id);
        router.replace(`/book-index?${params.toString()}`, { scroll: false });
        // 同步重建 graph（lineageWork/lineageBooks 已在 loadLineage 时缓存）
        if (lineageWork) {
            setLineageGraph(buildLineageGraph(lineageWork, lineageBooks, key));
        }
    };

    const loadCatalogs = useCallback(async (collectionId: string) => {
        const transport = getTransport(source);
        if (!transport.getCollectionCatalogs && !transport.getCollectionCatalog) return;

        setCatalogLoading(true);
        try {
            if (transport.getCollectionCatalogs) {
                const catalogs = await transport.getCollectionCatalogs(collectionId);
                setCatalogList(catalogs || []);
            } else if (transport.getCollectionCatalog) {
                const catalog = await transport.getCollectionCatalog(collectionId);
                if (catalog) {
                    setCatalogList([{ resource_id: '', data: catalog }]);
                } else {
                    setCatalogList([]);
                }
            }
        } catch {
            setCatalogList([]);
        } finally {
            setCatalogLoading(false);
        }
    }, [source]);

    const loadCollated = useCallback(async (workId: string) => {
        const transport = getTransport(source);
        if (!transport.getCollatedEditionIndex) return;

        setCollatedLoading(true);
        try {
            const idx = await transport.getCollatedEditionIndex(workId);
            setCollatedIndex(idx);
        } catch {
            setCollatedIndex(null);
        } finally {
            setCollatedLoading(false);
        }
    }, [source]);

    const loadLineage = useCallback(async (workId: string, workData: DetailWithAssets) => {
        setLineageLoading(true);
        try {
            // 先尝试从 transport 获取预构建的 lineage graph
            const transport = getTransport(source);
            if (transport.getLineageGraph) {
                const graph = await transport.getLineageGraph(workId);
                if (graph) {
                    setLineageGraph(graph);
                    return;
                }
            }

            // 如果没有预构建的数据，从 work 的 version_graph 和 books 构建
            if (!workData.version_graph || !workData.version_graph.enabled) {
                setLineageGraph(null);
                return;
            }

            // 获取关联的所有 book 数据
            const bookIds = workData.books || [];
            if (bookIds.length === 0) {
                setLineageGraph(null);
                return;
            }

            // 批量获取 book 详情
            const books: BookDetailData[] = [];
            for (const bookId of bookIds) {
                try {
                    const bookData = await transport.getItem(bookId);
                    if (bookData && typeof bookData === 'object') {
                        books.push(bookData as unknown as BookDetailData);
                    }
                } catch {
                    // 忽略无法加载的 book
                }
            }

            // 构建 lineage graph（按 URL 中的 collection 参数过滤；默认 undefined → buildLineageGraph 自取 default_collection）
            const wd = workData as unknown as WorkDetailData;
            setLineageWork(wd);
            setLineageBooks(books);
            const graph = buildLineageGraph(wd, books, lineageCollection);
            setLineageGraph(graph);
        } catch {
            setLineageGraph(null);
        } finally {
            setLineageLoading(false);
        }
    }, [source]);

    useEffect(() => {
        const loadData = async () => {
            try {
                setIsLoading(true);
                setError(null);
                setCatalogList([]);
                setCollatedIndex(null);
                setLineageGraph(null);

                const transport = getTransport(source);

                const entryData = await transport.getEntry(id);
                if (!entryData) {
                    setError('not-found');
                    return;
                }
                setEntry(entryData);
                // 标题在下方独立 effect 中设置（跟随 locale 变化）

                const raw = await transport.getItem(id);
                if (!raw) {
                    setError('not-found');
                    return;
                }
                const detailData = raw as unknown as DetailWithAssets;
                enrichDigitalAssets(id, entryData, detailData);
                setDetail(detailData);

                // 根据类型加载额外资源
                if (detailData.type === 'collection') {
                    loadCatalogs(id);
                } else if (detailData.type === 'work') {
                    loadCollated(id);
                    loadLineage(id, detailData);
                }
            } catch (err) {
                setError(err instanceof Error ? err.message : '加载失败');
            } finally {
                setIsLoading(false);
            }
        };

        loadData();
        return () => { document.title = '開源古籍'; };
    }, [id, source, loadCatalogs, loadCollated, loadLineage]);

    // 标题随书名和繁简 locale 同步更新
    useEffect(() => {
        if (!entry) return;
        document.title = `${convert(entry.title)} - ${convert('開源古籍')}`;
    }, [entry, convert]);

    if (error === 'not-found') {
        notFound();
    }

    if (isLoading) {
        return (
            <LayoutWrapper hideFooter={true} hideFeedbackButton={true}>
                <div className="max-w-4xl mx-auto px-6 py-8 animate-pulse">
                    <div className="h-8 w-48 bg-paper/50 rounded mb-8" />
                    <div className="h-12 w-3/4 bg-paper/50 rounded mb-8" />
                    <div className="h-64 w-full bg-paper/50 rounded" />
                </div>
            </LayoutWrapper>
        );
    }

    if (!entry || !detail) return null;

    // 构建导航项
    const navItems: NavItem[] = [
        { key: 'basic', label: '基本信息' },
    ];
    // 丛编目录 tab（每个资源一个）
    if (detail.type === 'collection') {
        if (catalogLoading && catalogList.length === 0) {
            navItems.push({ key: 'catalog:loading' as TabType, label: '目录...' });
        }
        for (const cat of catalogList) {
            navItems.push({
                key: `catalog:${cat.resource_id}`,
                label: cat.short_name ? `${cat.short_name}·目录` : '丛编目录',
            });
        }
    }
    // 整理本 tab（卷结构浏览）
    if (detail.type === 'work' && (collatedIndex || collatedLoading)) {
        navItems.push({
            key: 'collated',
            label: collatedLoading ? '整理本...' : '整理本',
        });
    }
    // 版本传承 tab（version_graph 展示）
    if (detail.type === 'work' && (lineageGraph || lineageLoading)) {
        navItems.push({
            key: 'lineage',
            label: lineageLoading ? '版本传承...' : '版本传承',
        });
    }
    // 考证 tab（emendated_by 条目展示）
    if (detail.emendated_by && detail.emendated_by.length > 0) {
        navItems.push({ key: 'emendated', label: '考證' });
    }
    // 数字化资源 tab（tex/影像）
    if (detail.digital_assets) {
        navItems.push({ key: 'digital', label: '数字化' });
    }
    // 反馈讨论 tab（所有类型都有）
    navItems.push({ key: 'feedback', label: '反馈' });

    // 渲染当前 tab 内容
    const renderContent = () => {
        if (activeTab === 'basic') {
            return (
                <div className="max-w-4xl px-4 md:px-8 pt-4 md:pt-6 pb-8">
                    <IndexView
                        data={detail}
                        transport={getTransport(source)}
                        mode="view"
                        renderLink={(linkId, label) => <BidLink id={linkId}>{label}</BidLink>}
                        headerExtra={<LocaleToggle />}
                    />
                </div>
            );
        }

        if (activeTab.startsWith('catalog:')) {
            const catData = catalogList.find(c => `catalog:${c.resource_id}` === activeTab)?.data;
            return (
                <div className="max-w-4xl px-4 md:px-8 pt-4 md:pt-6 pb-8">
                    <CollectionCatalog
                        data={catData}
                        onNavigate={handleNavigate}
                        renderLink={(linkId, label) => (
                            <a
                                href={`/book-index?id=${linkId}`}
                                className="text-vermilion hover:underline"
                            >
                                {label || linkId}
                            </a>
                        )}
                    />
                </div>
            );
        }

        if (activeTab === 'collated') {
            const transport = getTransport(source);
            return (
                <div className="max-w-4xl px-4 md:px-8 pt-4 md:pt-6 pb-8 relative">
                    <div className="absolute top-6 right-8 z-10">
                        <LocaleToggle />
                    </div>
                    <CollatedEdition
                        index={collatedIndex || undefined}
                        workId={id}
                        transport={transport}
                        onNavigate={handleNavigate}
                    />
                </div>
            );
        }

        if (activeTab === 'lineage' && lineageGraph) {
            return (
                <div className="max-w-4xl px-4 md:px-8 pt-4 md:pt-6 pb-8 relative">
                    <div className="absolute top-6 right-8 z-10">
                        <LocaleToggle />
                    </div>
                    <VersionLineageView
                        graph={lineageGraph}
                        renderLink={(linkId, label) => <BidLink id={linkId}>{label}</BidLink>}
                        graphHeight={600}
                        defaultMode={lineageMode}
                        onModeChange={handleLineageModeChange}
                        collection={lineageCollection ?? lineageWork?.version_graph?.default_collection}
                        onCollectionChange={handleLineageCollectionChange}
                        collectionsAvailable={lineageWork?.version_graph?.collections}
                        collectionCounts={(() => {
                            // 为每个集合算节点数（含桥接），用于按钮上显示徽标
                            if (!lineageWork) return undefined;
                            const cs = lineageWork.version_graph?.collections;
                            if (!cs) return undefined;
                            const out: Record<string, number> = {};
                            for (const k of Object.keys(cs)) {
                                out[k] = buildLineageGraph(lineageWork, lineageBooks, k).nodes.length;
                            }
                            return out;
                        })()}
                    />
                </div>
            );
        }

        if (activeTab === 'emendated' && detail.emendated_by && detail.emendated_by.length > 0) {
            return (
                <div className="max-w-4xl px-4 md:px-8 pt-4 md:pt-6 pb-8 relative">
                    <div className="absolute top-6 right-8 z-10">
                        <LocaleToggle />
                    </div>
                    <EmendatedBySection
                        items={detail.emendated_by}
                        onNavigate={handleNavigate}
                        renderLink={(linkId, label) => <BidLink id={linkId}>{label}</BidLink>}
                    />
                </div>
            );
        }

        if (activeTab === 'digital' && detail.digital_assets) {
            return (
                <div className="px-4 pb-8">
                    <DigitalizationView id={id} assets={detail.digital_assets} initialPage={initialPage} />
                </div>
            );
        }

        if (activeTab === 'feedback') {
            return (
                <div className="max-w-4xl px-4 md:px-8 pt-4 md:pt-6 pb-8">
                    <FeedbackTab resourceId={id} />
                </div>
            );
        }

        return null;
    };

    return (
        <LayoutWrapper hideFooter={true} hideFeedbackButton={true}>
            {/* 手机：顶部 tab */}
            <div className="flex flex-col md:hidden" style={{ height: 'calc(100vh - 2.5rem)' }}>
                <TopNav items={navItems} activeKey={activeTab} onSelect={setActiveTab} />
                <div className="flex-1 overflow-auto">
                    {renderContent()}
                </div>
            </div>

            {/* 桌面：左侧侧边栏 */}
            <div className="hidden md:flex" style={{ height: 'calc(100vh - 2.5rem)' }}>
                <div className="w-36 flex-shrink-0 border-r border-border/30">
                    <SideNav items={navItems} activeKey={activeTab} onSelect={setActiveTab} />
                </div>
                <div className="flex-1 overflow-auto">
                    {renderContent()}
                </div>
            </div>
        </LayoutWrapper>
    );
}
