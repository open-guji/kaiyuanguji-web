'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { getTransport } from '@/lib/transport';
import { useSource } from '@/components/common/SourceContext';
import type { IndexEntry, IndexType } from 'book-index-ui';
import type { DataSource } from '@/lib/constants';

interface BidLinkProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
    id: string;
}

// 跨 BidLink 实例共享：用一次 getAllEntries 填一张 id→entry 大表，
// 避免人物详情页几百个链接各自打一次 getEntry 把 dev server 打爆。
const allEntriesCache = new Map<DataSource, Promise<Map<string, IndexEntry>>>();

function getAllEntriesMap(source: DataSource): Promise<Map<string, IndexEntry>> {
    const cached = allEntriesCache.get(source);
    if (cached) return cached;
    const transport = getTransport(source);
    const p = (async () => {
        const all = transport.getAllEntries ? await transport.getAllEntries() : [];
        const map = new Map<string, IndexEntry>();
        for (const e of all) map.set(e.id, e);
        return map;
    })();
    allEntriesCache.set(source, p);
    return p;
}

export default function BidLink({ id, children, className, ...props }: BidLinkProps) {
    const { source } = useSource();
    const [type, setType] = useState<IndexType | null>(null);
    const [name, setName] = useState<string | null>(null);

    useEffect(() => {
        let isMounted = true;
        (async () => {
            try {
                const map = await getAllEntriesMap(source);
                const entry = map.get(id);
                if (isMounted && entry) {
                    setType(entry.type);
                    setName(entry.title);
                }
            } catch (err) {
                console.error(`Failed to fetch book info for ID: ${id}`, err);
            }
        })();
        return () => { isMounted = false; };
    }, [id, source]);

    const renderIcon = () => {
        const iconBaseClass = "w-3.5 h-3.5 inline-block mr-1 opacity-70 align-middle";

        switch (type) {
            case 'book':
                return (
                    <svg className={iconBaseClass} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                    </svg>
                );
            case 'collection':
                return (
                    <svg className={iconBaseClass} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                    </svg>
                );
            case 'work':
                return (
                    <svg className={iconBaseClass} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                );
            default:
                return null;
        }
    };

    // 调用方传 id 作 children 当占位（标题尚未加载）时，回退到自取的 name
    const isIdPlaceholder = typeof children === 'string' && children === id;
    const display = (!isIdPlaceholder && children) || name || id;

    return (
        <Link
            href={`/book-index?id=${id}`}
            className={`inline-flex items-center text-vermilion hover:underline font-medium decoration-dotted underline-offset-4 ${className || ''}`}
            {...props}
        >
            {renderIcon()}
            <span>{display}</span>
        </Link>
    );
}
