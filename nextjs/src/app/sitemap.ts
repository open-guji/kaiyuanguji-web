import { MetadataRoute } from 'next';
import { SITE_URL, NAV_ITEMS, ROADMAP_MODULES } from '@/lib/constants';
import { fetchAllBooks } from '@/services/bookIndex';

export const dynamic = 'force-static';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
    const lastModified = new Date();

    // 1. 静态路由
    const staticRoutes = NAV_ITEMS.filter(item => !item.isExternal).map((item) => ({
        url: `${SITE_URL}${item.href}`,
        lastModified,
        changeFrequency: 'weekly' as const,
        priority: item.href === '/' ? 1 : 0.8,
    }));

    // 2. 路线图详情页
    const roadmapRoutes = ROADMAP_MODULES.map((module) => ({
        url: `${SITE_URL}${module.href}`,
        lastModified,
        changeFrequency: 'monthly' as const,
        priority: 0.7,
    }));

    // 3. 古籍详情页 (从 GitHub 获取)
    let bookRoutes: MetadataRoute.Sitemap = [];
    try {
        const books = await fetchAllBooks();
        bookRoutes = books.map((book) => ({
            url: `${SITE_URL}/book-index/${book.id}`,
            lastModified,
            changeFrequency: 'monthly' as const,
            priority: 0.6,
        }));
    } catch (error) {
        console.error('Failed to fetch books for sitemap:', error);
    }

    return [...staticRoutes, ...roadmapRoutes, ...bookRoutes];
}
