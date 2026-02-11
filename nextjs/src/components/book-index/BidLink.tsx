'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { findBookById } from '@/services/bookIndex';
import { useSource } from '@/components/common/SourceContext';
import { BookResourceType } from '@/types';

interface BidLinkProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
    id: string;
}

export default function BidLink({ id, children, className, ...props }: BidLinkProps) {
    const { source } = useSource();
    const [type, setType] = useState<BookResourceType | null>(null);
    const [name, setName] = useState<string | null>(null);

    useEffect(() => {
        let isMounted = true;
        const fetchBookInfo = async () => {
            try {
                const book = await findBookById(id, source);
                if (isMounted && book) {
                    setType(book.type);
                    setName(book.name);
                }
            } catch (err) {
                console.error(`Failed to fetch book info for ID: ${id}`, err);
            }
        };

        fetchBookInfo();
        return () => { isMounted = false; };
    }, [id, source]);

    const renderIcon = () => {
        const iconBaseClass = "w-3.5 h-3.5 inline-block mr-1 opacity-70 align-middle";

        switch (type) {
            case BookResourceType.BOOK:
                return (
                    <svg className={iconBaseClass} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                    </svg>
                );
            case BookResourceType.COLLECTION:
                return (
                    <svg className={iconBaseClass} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                    </svg>
                );
            case BookResourceType.WORK:
                return (
                    <svg className={iconBaseClass} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.5">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                );
            default:
                return null;
        }
    };

    return (
        <Link
            href={`/book-index/${id}`}
            className={`inline-flex items-center text-vermilion hover:underline font-medium decoration-dotted underline-offset-4 ${className || ''}`}
            {...props}
        >
            {renderIcon()}
            <span>{name || children || id}</span>
        </Link>
    );
}
