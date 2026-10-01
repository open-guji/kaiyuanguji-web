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

    // 2b. 只在页脚出现、不在主导航里的独立页面
    const footerOnlyRoutes: MetadataRoute.Sitemap = [
        { url: `${SITE_URL}/about`, lastModified, changeFrequency: 'monthly' as const, priority: 0.5 },
        { url: `${SITE_URL}/beta`, lastModified, changeFrequency: 'monthly' as const, priority: 0.5 },
    ];

    // 3. 古籍详情页 (从 GitHub 获取)
    // 全栈构建（KYG_RENDER_MODE=fullstack）不列：条目地址是 /item/<id>，由 scripts/gen-sitemaps.mjs
    // 生成的 /sitemaps/* 分片列出（sitemap-index.xml 汇总），这里再列旧的 /book-index?id= 只会重复，
    // 还会带出草稿 id。静态导出（正式站现行）照旧列，切域名前行为不变。
    if (process.env.KYG_RENDER_MODE === 'fullstack') {
        // 导航里的 /catalog、/read 不在 lib/constants 的 NAV_ITEMS 里（那份是旧站导航），这里补上；
        // 总目与阅读首页的分类节点页由 scripts/gen-sitemaps.mjs 列进 sitemaps/nodes-001.xml（overview#280 S3）
        const fullstackPages = ['/catalog', '/read'].map((path) => ({
            url: `${SITE_URL}${path}`, lastModified, changeFrequency: 'weekly' as const, priority: 0.8,
        }));
        return [...staticRoutes, ...fullstackPages, ...roadmapRoutes, ...footerOnlyRoutes];
    }
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

    return [...staticRoutes, ...roadmapRoutes, ...footerOnlyRoutes, ...bookRoutes];
}
