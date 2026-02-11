'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import LayoutWrapper from '@/components/layout/LayoutWrapper';
import { findBookById, fetchBookDetail, getTypeLabel, getStatusLabel } from '@/services/bookIndex';
import {
    BookIndexItem,
    BookIndexDetailData,
    BaseDetailData,
    BookDetailData,
    CollectionDetailData,
    WorkDetailData,
    AuthorInfo,
    ResourceLink,
    LocationInfo,
} from '@/types';
import CopyButton from '@/components/common/CopyButton';
import SourceToggle from '@/components/common/SourceToggle';
import { useSource } from '@/components/common/SourceContext';
import { notFound } from 'next/navigation';
import BidLink from './BidLink';

interface BookDetailContentProps {
    id: string;
}

function SectionHeading({ children }: { children: React.ReactNode }) {
    return (
        <h2 className="text-xl font-bold text-ink mt-8 mb-4 tracking-wide border-b border-border/40 pb-2">
            {children}
        </h2>
    );
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="flex py-2.5 border-b border-border/20 last:border-b-0">
            <span className="w-28 flex-shrink-0 text-sm text-secondary font-medium">{label}</span>
            <span className="text-sm text-ink flex-1">{children}</span>
        </div>
    );
}

function AuthorList({ authors }: { authors: AuthorInfo[] }) {
    return (
        <span>
            {authors.map((a, i) => (
                <span key={i}>
                    {i > 0 && '、'}
                    {a.dynasty && <span className="text-secondary">[{a.dynasty}] </span>}
                    {a.name}
                    {a.role && <span className="text-secondary"> ({a.role})</span>}
                </span>
            ))}
        </span>
    );
}

function ResourceList({ resources, label }: { resources: ResourceLink[]; label: string }) {
    if (resources.length === 0) return null;
    return (
        <>
            <SectionHeading>{label}</SectionHeading>
            <ul className="space-y-2">
                {resources.map((r, i) => (
                    <li key={i} className="flex items-start gap-2">
                        <svg className="w-4 h-4 mt-0.5 text-vermilion flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                        </svg>
                        <div>
                            <a
                                href={r.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-vermilion hover:underline font-medium text-sm"
                            >
                                {r.name || r.title}
                            </a>
                            {r.details && (
                                <span className="text-secondary text-xs ml-2">— {r.details}</span>
                            )}
                        </div>
                    </li>
                ))}
            </ul>
        </>
    );
}

function LocationHistory({ history }: { history: LocationInfo[] }) {
    if (history.length === 0) return null;
    return (
        <>
            <SectionHeading>流转历史</SectionHeading>
            <div className="relative pl-6 space-y-4">
                <div className="absolute left-2 top-2 bottom-2 w-px bg-border/60" />
                {history.map((loc, i) => (
                    <div key={i} className="relative">
                        <div className="absolute -left-4 top-1.5 w-2.5 h-2.5 rounded-full bg-vermilion border-2 border-white" />
                        <div>
                            <span className="text-sm font-medium text-ink">{loc.name}</span>
                            {loc.description && (
                                <p className="text-sm text-secondary mt-1">{loc.description}</p>
                            )}
                        </div>
                    </div>
                ))}
            </div>
        </>
    );
}

function BidLinkList({ ids, label }: { ids: string[]; label: string }) {
    if (ids.length === 0) return null;
    return (
        <>
            <SectionHeading>{label}</SectionHeading>
            <ul className="space-y-2">
                {ids.map((id) => (
                    <li key={id} className="flex items-start gap-2">
                        <svg className="w-4 h-4 mt-0.5 text-vermilion flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                        </svg>
                        <BidLink id={id} />
                    </li>
                ))}
            </ul>
        </>
    );
}

function renderBaseInfo(detail: BookIndexDetailData) {
    return (
        <div className="bg-paper/30 rounded-xl border border-border/40 p-5 mt-6">
            {detail.authors && detail.authors.length > 0 && (
                <InfoRow label={detail.type === 'collection' ? '编者' : '作者'}><AuthorList authors={detail.authors} /></InfoRow>
            )}
            {detail.publication_info?.year && (
                <InfoRow label="年代">{detail.publication_info.year}</InfoRow>
            )}
            {detail.current_location?.name && (
                <InfoRow label="现藏于">{detail.current_location.name}</InfoRow>
            )}
            {detail.volume_count?.description && (
                <InfoRow label="卷册">{detail.volume_count.description}</InfoRow>
            )}
            {detail.page_count?.description && (
                <InfoRow label="页数">{detail.page_count.description}</InfoRow>
            )}
            {(detail as BookDetailData).contained_in && (detail as BookDetailData).contained_in!.length > 0 && (
                <InfoRow label="收录于">{(detail as BookDetailData).contained_in!.join('、')}</InfoRow>
            )}
            {(detail as BookDetailData).work_id && (
                <InfoRow label="所属作品"><BidLink id={(detail as BookDetailData).work_id!} /></InfoRow>
            )}
            {(detail as WorkDetailData).parent_work && (
                <InfoRow label="上级作品"><BidLink id={(detail as WorkDetailData).parent_work!.id} /></InfoRow>
            )}
            {(detail as WorkDetailData).parent_works && (detail as WorkDetailData).parent_works!.length > 0 && (
                <InfoRow label="上级作品">
                    <span className="flex flex-wrap gap-2">
                        {(detail as WorkDetailData).parent_works!.map((id) => (
                            <BidLink key={id} id={id} />
                        ))}
                    </span>
                </InfoRow>
            )}
        </div>
    );
}

function renderResources(detail: BaseDetailData) {
    return (
        <>
            {/* Text Resources */}
            {detail.text_resources && detail.text_resources.length > 0 && (
                <ResourceList resources={detail.text_resources} label="文字资源" />
            )}

            {/* Image Resources */}
            {detail.image_resources && detail.image_resources.length > 0 && (
                <ResourceList resources={detail.image_resources} label="影像资源" />
            )}
        </>
    );
}

function renderBookDetail(detail: BookDetailData) {
    return (
        <>
            {/* Basic Info */}
            {renderBaseInfo(detail)}

            {/* Description */}
            {detail.description?.text && (
                <>
                    <SectionHeading>简介</SectionHeading>
                    <p className="text-base text-ink leading-loose">{detail.description.text}</p>
                </>
            )}

            {/* Resources */}
            {renderResources(detail)}

            {/* Location History */}
            {detail.location_history && detail.location_history.length > 0 && (
                <LocationHistory history={detail.location_history} />
            )}

            {/* Related Books */}
            {detail.related_books && detail.related_books.length > 0 && (
                <BidLinkList ids={detail.related_books} label="相关版本" />
            )}
        </>
    );
}

function renderCollectionDetail(detail: CollectionDetailData) {
    return (
        <>
            {renderBaseInfo(detail)}

            {detail.description?.text && (
                <>
                    <SectionHeading>简介</SectionHeading>
                    <p className="text-base text-ink leading-loose">{detail.description.text}</p>
                </>
            )}

            {renderResources(detail)}

            {detail.history && detail.history.length > 0 && (
                <>
                    <SectionHeading>历史沿革</SectionHeading>
                    <ul className="space-y-2">
                        {detail.history.map((item, i) => (
                            <li key={i} className="text-sm text-ink leading-relaxed flex gap-2">
                                <span className="text-vermilion mt-1">•</span>
                                <span>{item}</span>
                            </li>
                        ))}
                    </ul>
                </>
            )}

            {detail.books && detail.books.length > 0 && (
                <BidLinkList ids={detail.books} label="收录书籍" />
            )}
        </>
    );
}

function renderWorkDetail(detail: WorkDetailData) {
    return (
        <>
            {renderBaseInfo(detail)}

            {detail.description?.text && (
                <>
                    <SectionHeading>简介</SectionHeading>
                    <p className="text-base text-ink leading-loose">{detail.description.text}</p>
                </>
            )}

            {renderResources(detail)}

            {detail.books && detail.books.length > 0 && (
                <BidLinkList ids={detail.books} label="相关版本" />
            )}
        </>
    );
}

export default function BookDetailContent({ id }: BookDetailContentProps) {
    const { source } = useSource();
    const [book, setBook] = useState<BookIndexItem | null>(null);
    const [detail, setDetail] = useState<BookIndexDetailData | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        const loadData = async () => {
            try {
                setIsLoading(true);
                setError(null);

                const bookData = await findBookById(id, source);
                if (!bookData) {
                    setError('not-found');
                    return;
                }
                setBook(bookData);

                const detailData = await fetchBookDetail(bookData, source);
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
            <LayoutWrapper>
                <div className="max-w-4xl mx-auto px-6 py-8 animate-pulse">
                    <div className="h-8 w-48 bg-paper/50 rounded mb-8" />
                    <div className="h-12 w-3/4 bg-paper/50 rounded mb-8" />
                    <div className="h-64 w-full bg-paper/50 rounded" />
                </div>
            </LayoutWrapper>
        );
    }

    if (!book || !detail) return null;

    return (
        <LayoutWrapper>
            <div className="max-w-4xl mx-auto px-6 py-8">
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
                            {getTypeLabel(book.type)}
                        </span>
                        <span className={`px-2 py-0.5 text-xs font-medium rounded ${book.isDraft ? 'text-orange-600 bg-orange-50' : 'text-green-600 bg-green-50'}`}>
                            {getStatusLabel(book.isDraft)}
                        </span>
                    </div>

                    <div className="flex items-center gap-4">
                        <SourceToggle />
                        <CopyButton text={book.id} label="ID" />
                    </div>
                </div>

                <h1 className="text-4xl font-bold text-ink mb-2 tracking-wide">
                    {detail.title}
                </h1>

                {/* Type-specific rendering */}
                {detail.type === 'book' && renderBookDetail(detail as BookDetailData)}
                {detail.type === 'collection' && renderCollectionDetail(detail as CollectionDetailData)}
                {detail.type === 'work' && renderWorkDetail(detail as WorkDetailData)}
            </div>
        </LayoutWrapper>
    );
}
