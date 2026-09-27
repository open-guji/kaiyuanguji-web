'use client';

import { Suspense } from 'react';
import { LocaleProvider } from 'book-index-ui';
import BookDetailContent from '@/components/book-index/BookDetailContent';

/**
 * 条目页的客户端部分：与 /book-index?id= 挂同一个详情组件，行为不变（阅读器 UI 冻结）。
 *
 * BookDetailContent 读 useSearchParams，服务端渲染时会退到最近的 Suspense 边界，
 * 所以 HTML 里出现的是 fallback——这里让 fallback 用服务端取好的首屏摘要
 * （书名、作者、简介），浏览器接管后换成完整详情。
 */
export default function ItemDetailClient({ id, fallback }: { id: string; fallback: React.ReactNode }) {
    return (
        <LocaleProvider>
            <Suspense fallback={fallback}>
                <BookDetailContent id={id} />
            </Suspense>
        </LocaleProvider>
    );
}
