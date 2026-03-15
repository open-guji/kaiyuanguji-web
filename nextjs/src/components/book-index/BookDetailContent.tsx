'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import LayoutWrapper from '@/components/layout/LayoutWrapper';
import { getTransport, getTypeLabel, getStatusLabel } from '@/lib/transport';
import { isLocalMode } from '@/lib/constants';
import { IndexDetail } from 'book-index-ui';
import type { IndexEntry, IndexDetailData, ResourceEntry } from 'book-index-ui';
import CopyButton from '@/components/common/CopyButton';
import SourceToggle from '@/components/common/SourceToggle';
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
    text_resources?: { name?: string; title?: string; url: string; details?: string }[];
    image_resources?: { name?: string; title?: string; url: string; details?: string }[];
};

/** 将旧格式资源字段转为统一 ResourceEntry[] */
function normalizeResources(detail: DetailWithAssets): ResourceEntry[] {
    if (detail.resources && detail.resources.length > 0) {
        return detail.resources.map((r, i) => ({
            id: r.id || `res-${i}`,
            name: r.name || '',
            url: r.url,
            type: r.type,
            details: r.details,
        }));
    }
    const entries: ResourceEntry[] = [];
    if (detail.text_resources) {
        detail.text_resources.forEach((r, i) => {
            entries.push({ id: `text-${i}`, name: r.name || r.title || '', url: r.url, type: 'text', details: r.details });
        });
    }
    if (detail.image_resources) {
        detail.image_resources.forEach((r, i) => {
            entries.push({ id: `img-${i}`, name: r.name || r.title || '', url: r.url, type: 'image', details: r.details });
        });
    }
    return entries;
}

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

    const indexDetailData: IndexDetailData = {
        ...detail,
        resources: normalizeResources(detail),
    } as IndexDetailData;

    return (
        <LayoutWrapper hideFooter={true}>
            {/* Header section — centered */}
            <div className="max-w-4xl mx-auto px-6 pt-8">
                {/* Top Control Bar */}
                <div className="flex items-center justify-between mb-8 flex-wrap gap-4">
                    <div className="flex items-center gap-3 flex-wrap">
                        <Link
                            href="/book-index"
                            className="flex items-center gap-1 text-sm text-secondary hover:text-vermilion transition-colors"
                        >
                            <svg className="w-4 h-4" fill="none" strokeWidth="2" viewBox="0 0 24 24" stroke="currentColor">
                                <path d="M15 19l-7-7 7-7" />
                            </svg>
                            <span>返回索引</span>
                        </Link>
                        <span className="text-secondary/30">|</span>
                        <span className="px-2 py-0.5 text-xs font-medium rounded bg-paper text-secondary border border-border/60">
                            {getTypeLabel(entry.type)}
                        </span>
                        <span className={`px-2 py-0.5 text-xs font-medium rounded ${entry.isDraft ? 'text-orange-600 bg-orange-50' : 'text-green-600 bg-green-50'}`}>
                            {getStatusLabel(entry.isDraft)}
                        </span>
                    </div>

                    <div className="flex items-center gap-4">
                        <SourceToggle />
                        <CopyButton text={entry.id} label="ID" />
                    </div>
                </div>

                {/* Tabs */}
                <div className="flex border-b border-border/40 mt-6 overflow-x-auto no-scrollbar">
                    <button
                        onClick={() => setActiveTab('basic')}
                        className={`px-6 py-3 text-sm font-medium transition-colors relative ${activeTab === 'basic' ? 'text-vermilion' : 'text-secondary hover:text-ink'
                            }`}
                    >
                        基本信息
                        {activeTab === 'basic' && (
                            <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-vermilion" />
                        )}
                    </button>
                    {detail.digital_assets && (
                        <button
                            onClick={() => setActiveTab('digital')}
                            className={`px-6 py-3 text-sm font-medium transition-colors relative flex items-center gap-2 ${activeTab === 'digital' ? 'text-vermilion' : 'text-secondary hover:text-ink'
                                }`}
                        >
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                            </svg>
                            数字化
                            {activeTab === 'digital' && (
                                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-vermilion" />
                            )}
                        </button>
                    )}
                </div>
            </div>

            {/* Content section */}
            {activeTab === 'basic' ? (
                <div className="max-w-4xl mx-auto px-6 pb-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
                    <IndexDetail
                        data={indexDetailData}
                        renderLink={(linkId) => <BidLink id={linkId} />}
                    />
                </div>
            ) : (
                <div className="px-4 pb-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
                    {detail.digital_assets && (
                        <DigitalizationView id={id} assets={detail.digital_assets} initialPage={initialPage} />
                    )}
                </div>
            )}
        </LayoutWrapper>
    );
}
