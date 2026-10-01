'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import styles from './RailSearch.module.css';
import { useSiteT } from '@/i18n/use-site-t';

/**
 * 条目页左栏的站内检索框（传给 BookDetailLayout 的 railTop）。
 * 回车跳到搜索结果页 /book-index?q=；JS 未加载时表单照样 GET 过去。
 */
export default function RailSearch() {
    const router = useRouter();
    const t = useSiteT();
    const [query, setQuery] = useState('');

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        const q = query.trim();
        router.push(q ? `/book-index?q=${encodeURIComponent(q)}` : '/book-index');
    };

    return (
        <form className={styles.form} action="/book-index" method="get" role="search" onSubmit={handleSubmit}>
            <svg className={styles.icon} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" strokeLinecap="round" />
            </svg>
            <input
                className={styles.input}
                type="search"
                name="q"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('bookIndex.rail.placeholder')}
                aria-label={t('bookIndex.rail.label')}
                enterKeyHint="search"
            />
        </form>
    );
}
