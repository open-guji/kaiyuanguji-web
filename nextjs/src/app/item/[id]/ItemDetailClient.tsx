'use client';

import { Suspense, useEffect } from 'react';
import { saveRecentId } from 'book-index-ui';
import BimLocaleProvider from '@/components/common/BimLocaleProvider';
import BookDetailContent from '@/components/book-index/BookDetailContent';

/**
 * 条目页的客户端部分：与 /book-index?id= 挂同一个详情组件，行为不变（阅读器 UI 冻结）。
 *
 * BookDetailContent 读 useSearchParams，服务端渲染时会退到最近的 Suspense 边界，
 * 所以 HTML 里出现的是 fallback——这里让 fallback 用服务端取好的首屏摘要
 * （书名、作者、简介），浏览器接管后换成完整详情。
 *
 * 打开条目就记进「最近浏览」（overview#359 P2-1）：原来只有旧 IndexBrowser 里点结果才写，
 * 条目页（站内点进、直开、搜索引擎来的）从不写，元数据首页的「最近浏览」永远是空的。
 * 走到这里的 id 都是查到了的正式 id（查不到 404、被并／升格在服务端已跳走）。
 */
export default function ItemDetailClient({ id, fallback, initialDetail }: { id: string; fallback: React.ReactNode; initialDetail?: Record<string, unknown> }) {
    useEffect(() => { saveRecentId(id); }, [id]);
    return (
        <BimLocaleProvider>
            <Suspense fallback={fallback}>
                <BookDetailContent id={id} initialDetail={initialDetail} />
            </Suspense>
        </BimLocaleProvider>
    );
}
