'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import LayoutWrapper from '@/components/layout/LayoutWrapper';
import { getTransport } from '@/lib/transport';
import { isLocalMode } from '@/lib/constants';
import { IndexDetail } from 'book-index-ui';
import type { IndexEntry, IndexDetailData } from 'book-index-ui';
import { useSource } from '@/components/common/SourceContext';
import { notFound, useRouter, useSearchParams, usePathname } from 'next/navigation';
import BidLink from './BidLink';
import DigitalizationView from './DigitalizationView';
import type { DigitalAssets } from '@/types';

type TabType = 'basic' | 'digital';

interface BookDetailContentProps {
    id: string;
}

/** 详情数据 + 网站特有字段 */
type DetailWithAssets = IndexDetailData & {
    digital_assets?: DigitalAssets;
};

/** 本地模式下注入数字化资源信息 */
async function enrichDigitalAssets(id: string, entry: IndexEntry, detail: DetailWithAssets): Promise<void> {
    if (typeof window === 'undefined' || !isLocalMode) return;

    try {
        const pathParts = (entry.path || '').split('/');
        pathParts.pop();
        const baseDir = pathParts.join('/');
        const assetPath = baseDir ? `${baseDir}/${id}` : id;
        const basePath = `/local-data/${assetPath}`;

        const manifestUrl = `${basePath}/images/image_manifest.json`;
        const testRes = await fetch(manifestUrl, { method: 'HEAD' });
        if (testRes.ok) {
            detail.digital_assets = {
                image_manifest_url: manifestUrl,
                tex_files: ['ce01.tex'],
            };
        }
    } catch {
        // 忽略
    }
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
                className="flex items-center gap-1.5 px-5 py-2 text-sm text-secondary hover:text-vermilion transition-colors"
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
                                : 'text-secondary hover:text-ink'
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

export default function BookDetailContent({ id }: BookDetailContentProps) {
    const { source } = useSource();
    const router = useRouter();
    const searchParams = useSearchParams();
    const pathname = usePathname();

    const [entry, setEntry] = useState<IndexEntry | null>(null);
    const [detail, setDetail] = useState<DetailWithAssets | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const activeTab = (searchParams.get('tab') || 'basic') as TabType;
    const initialPage = parseInt(searchParams.get('page') || '1') || 1;

    const setActiveTab = (tab: TabType) => {
        const params = new URLSearchParams(searchParams.toString());
        params.set('tab', tab);
        if (tab === 'basic') {
            params.delete('page');
        }
        router.push(`${pathname}?${params.toString()}`, { scroll: false });
    };

    useEffect(() => {
        const loadData = async () => {
            try {
                setIsLoading(true);
                setError(null);

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
                await enrichDigitalAssets(id, entryData, detailData);
                setDetail(detailData);
            } catch (err) {
                setError(err instanceof Error ? err.message : '加载失败');
            } finally {
                setIsLoading(false);
            }
        };

        loadData();
    }, [id, source]);

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
    if (detail.digital_assets) {
        navItems.push({ key: 'digital', label: '整理本' });
    }

    return (
        <LayoutWrapper hideFooter={true}>
            <div className="flex" style={{ height: 'calc(100vh - 4rem)' }}>
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
                    {activeTab === 'basic' ? (
                        <div className="max-w-4xl px-8 pt-6 pb-8">
                            <IndexDetail
                                data={detail}
                                renderLink={(linkId) => <BidLink id={linkId} />}
                            />
                        </div>
                    ) : (
                        <div className="px-4 pb-8">
                            {detail.digital_assets && (
                                <DigitalizationView id={id} assets={detail.digital_assets} initialPage={initialPage} />
                            )}
                        </div>
                    )}
                </div>
            </div>
        </LayoutWrapper>
    );
}
