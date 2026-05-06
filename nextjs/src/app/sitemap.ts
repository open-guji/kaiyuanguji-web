import { MetadataRoute } from 'next';
import { GithubStorage } from 'book-index-ui/storage';
import { SITE_URL, NAV_ITEMS, ROADMAP_MODULES, GITHUB_ORG, JSDELIVR_FASTLY, JSDELIVR_CDN } from '@/lib/constants';

export const dynamic = 'force-static';

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
    const lastModified = new Date();

    // 1. 静态路由
    const staticRoutes = NAV_ITEMS.map((item) => ({
        url: `${SITE_URL}${item.href}`,
        lastModified,
        changeFrequency: 'weekly' as const,
        priority: item.href === '/' ? 1 : 0.8,
    }));

    // 2. 路线图模块页 (已简化为一级目录)
    const roadmapRoutes = ROADMAP_MODULES.map((module) => ({
        url: `${SITE_URL}${module.href}`,
        lastModified,
        changeFrequency: 'monthly' as const,
        priority: 0.8,
    }));

    // 3. 古籍详情页 (从 GitHub 获取)
    // 直接用 GithubStorage，不走 getTransport（避免 v2-storage / worker wrapper 拉到 server side）
    let bookRoutes: MetadataRoute.Sitemap = [];
    try {
        const transport = new GithubStorage({
            org: GITHUB_ORG,
            repos: { draft: 'book-index-draft', official: 'book-index' },
            baseUrl: 'https://raw.githubusercontent.com',
            cdnUrls: [JSDELIVR_FASTLY, JSDELIVR_CDN],
        });
        const allEntries = await transport.getAllEntries();
        bookRoutes = allEntries.map((entry) => ({
            url: `${SITE_URL}/book-index?id=${entry.id}`,
            lastModified,
            changeFrequency: 'monthly' as const,
            priority: 0.6,
        }));
    } catch (error) {
        console.error('Failed to fetch books for sitemap:', error);
    }

    return [...staticRoutes, ...roadmapRoutes, ...bookRoutes];
}
