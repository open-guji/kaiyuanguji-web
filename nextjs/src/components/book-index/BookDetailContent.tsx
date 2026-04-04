'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import LayoutWrapper from '@/components/layout/LayoutWrapper';
import { getTransport } from '@/lib/transport';
import { isLocalMode } from '@/lib/constants';
import { IndexView, CollectionCatalog, CollatedEdition } from 'book-index-ui';
import type { IndexEntry, IndexDetailData, ResourceCatalog, CollatedEditionIndex } from 'book-index-ui';
import { useSource } from '@/components/common/SourceContext';
import { notFound, useRouter, useSearchParams } from 'next/navigation';
import BidLink from './BidLink';
import DigitalizationView from './DigitalizationView';
import type { DigitalAssets } from '@/types';

type TabType = 'basic' | 'digital' | 'collated' | `catalog:${string}`;

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

/** 点击关联条目：跳转到对应详情页 */
function handleNavigate(targetId: string) {
    window.location.href = `/book-index?id=${targetId}`;
}

export default function BookDetailContent({ id }: BookDetailContentProps) {
    const { source } = useSource();
    const router = useRouter();
    const searchParams = useSearchParams();

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

    const activeTab = (searchParams.get('tab') || 'basic') as TabType;
    const initialPage = parseInt(searchParams.get('page') || '1') || 1;

    const setActiveTab = (tab: TabType) => {
        const params = new URLSearchParams(searchParams.toString());
        params.set('tab', tab);
        if (tab === 'basic') {
            params.delete('page');
        }
        params.set('id', id);
        router.push(`/book-index?${params.toString()}`, { scroll: false });
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

    useEffect(() => {
        const loadData = async () => {
            try {
                setIsLoading(true);
                setError(null);
                setCatalogList([]);
                setCollatedIndex(null);

                const transport = getTransport(source);

                const entryData = await transport.getEntry(id);
                if (!entryData) {
                    setError('not-found');
                    return;
                }
                setEntry(entryData);

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
                }
            } catch (err) {
                setError(err instanceof Error ? err.message : '加载失败');
            } finally {
                setIsLoading(false);
            }
        };

        loadData();
    }, [id, source, loadCatalogs, loadCollated]);

    if (error === 'not-found') {
        notFound();
    }

    if (isLoading) {
        return (
            <LayoutWrapper hideFooter={true}>
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
    // 数字化资源 tab（tex/影像）
    if (detail.digital_assets) {
        navItems.push({ key: 'digital', label: '数字化' });
    }

    // 渲染当前 tab 内容
    const renderContent = () => {
        if (activeTab === 'basic') {
            return (
                <div className="max-w-4xl px-8 pt-6 pb-8">
                    <IndexView
                        data={detail}
                        transport={getTransport(source)}
                        mode="view"
                        renderLink={(linkId, label) => <BidLink id={linkId}>{label}</BidLink>}
                    />
                </div>
            );
        }

        if (activeTab.startsWith('catalog:')) {
            const catData = catalogList.find(c => `catalog:${c.resource_id}` === activeTab)?.data;
            return (
                <div className="max-w-4xl px-8 pt-6 pb-8">
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
                <div className="max-w-4xl px-8 pt-6 pb-8">
                    <CollatedEdition
                        index={collatedIndex || undefined}
                        workId={id}
                        transport={transport}
                        onNavigate={handleNavigate}
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

        return null;
    };

    return (
        <LayoutWrapper hideFooter={true}>
            <div className="flex" style={{ height: 'calc(100vh - 2.5rem)' }}>
                {/* 左侧导航 */}
                <div className="w-36 flex-shrink-0 border-r border-border/30">
                    <SideNav
                        items={navItems}
                        activeKey={activeTab}
                        onSelect={setActiveTab}
                    />
                </div>

                {/* 右侧内容 */}
                <div className="flex-1 overflow-auto">
                    {renderContent()}
                </div>
            </div>
        </LayoutWrapper>
    );
}
