'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import LayoutWrapper from '@/components/layout/LayoutWrapper';
import MarkdownRenderer from '@/components/markdown/MarkdownRenderer';
import { findBookById, fetchBookContent, getTypeLabel, getStatusLabel } from '@/services/bookIndex';
import { BookIndexItem } from '@/types';
import CopyButton from '@/components/common/CopyButton';
import SourceToggle from '@/components/common/SourceToggle';
import { useSource } from '@/components/common/SourceContext';
import { notFound } from 'next/navigation';

interface BookDetailContentProps {
    id: string;
}

export default function BookDetailContent({ id }: BookDetailContentProps) {
    const { source } = useSource();
    const [book, setBook] = useState<BookIndexItem | null>(null);
    const [content, setContent] = useState<string>('');
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

                const markdown = await fetchBookContent(bookData, source);
                setContent(markdown);
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

    if (!book) return null;

    // 去重逻辑
    const stripRedundantHeader = (text: string) => {
        let cleanText = text.replace(/^#\s+.+\r?\n*/m, '');
        cleanText = cleanText.replace(/^(ID|id)[:：].*\r?\n*/mi, '');
        // 不再移除“基本信息”节点，直接渲染 Markdown 内容
        // cleanText = cleanText.replace(/^##\s*基本信息\s*\r?\n([\s\S]*?)(?=\r?\n##\s|$)/m, '');
        return cleanText.trim();
    };

    const cleanedContent = stripRedundantHeader(content);

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

                <h1 className="text-4xl font-bold text-ink mb-8 tracking-wide">
                    {book.name}
                </h1>

                {/* Metadata Card removed */}

                <div className="prose max-w-none">
                    <MarkdownRenderer content={cleanedContent} />
                </div>
            </div>
        </LayoutWrapper>
    );
}
