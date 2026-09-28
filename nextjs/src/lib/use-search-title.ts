'use client';

import { useEffect } from 'react';
import { SITE_NAME } from './constants';

/** 搜索页 <title>：「朱熹 - 搜索 - 开源古籍」；没有检索词就是站名 */
export function searchTitle(query: string | null | undefined): string {
    const q = (query ?? '').trim();
    return q ? `${q} - 搜索 - ${SITE_NAME}` : SITE_NAME;
}

/**
 * 搜索页是客户端页面（检索词在查询串里，静态导出下服务端读不到），title 在浏览器里跟着检索词改
 * （overview#267 P2-9）。enabled=false（进了条目详情）时不动，卸载时还原进来时的 title。
 */
export function useSearchTitle(query: string | null | undefined, enabled = true) {
    useEffect(() => {
        if (!enabled) return;
        const before = document.title;
        document.title = searchTitle(query);
        return () => { document.title = before; };
    }, [query, enabled]);
}
