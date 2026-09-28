'use client';

/**
 * 古籍总目的客户端部分：挂 book-index-ui 的 CatalogPage（N4a，0.10.1 起），把选节点、翻页接到路由上。
 *
 * 数据由 page.ssr.tsx 在服务端取好传进来，首屏 HTML 里就有分类树和作品卡；分页渲染成真链接
 * （pageHref），普通点击走 onPage。组件把 id 当成不透明字符串，节点 id 用构建脚本的 ASCII 方案。
 */
import { useRouter } from 'next/navigation';
import { CatalogPage, LocaleProvider } from 'book-index-ui';
import { CATALOG_ALL_ID, CATALOG_PATH, catalogHref, workHref, type CatalogNode, type CatalogWorkCard } from './catalog-route';

export interface CatalogClientProps {
    tree: CatalogNode[];
    selectedId: string;
    page: number;
    pageCount: number;
    works: CatalogWorkCard[];
}

export default function CatalogClient({ tree, selectedId, page, pageCount, works }: CatalogClientProps) {
    const router = useRouter();
    // 「全部」待用户定（overview#229）：先回到不带 node 的地址，即默认节点
    const onSelect = (id: string) => router.push(id === CATALOG_ALL_ID ? CATALOG_PATH : catalogHref(id));
    const onPage = (p: number) => router.push(catalogHref(selectedId, p));
    return (
        <LocaleProvider>
            <CatalogPage
                tree={tree}
                selectedId={selectedId}
                page={page}
                pageCount={pageCount}
                works={works}
                onSelect={onSelect}
                onPage={onPage}
                pageHref={(p) => catalogHref(selectedId, p)}
                workLink={workHref}
            />
        </LocaleProvider>
    );
}
