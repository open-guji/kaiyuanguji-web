import { MetadataRoute } from 'next';
import { SITE_URL, NAV_ITEMS, ROADMAP_MODULES } from '@/lib/constants';

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
    // 静态导出已不再部署（正式站、测试站都是全栈）。旧版这里用 GithubStorage 从 GitHub raw／jsDelivr 读
    // 仓内 index/ 分片列条目；仓内 index/ 将删（A11 schema 审查），条目地址统一由 gen-sitemaps.mjs 的 /sitemaps/* 列出。
    return [...staticRoutes, ...roadmapRoutes, ...footerOnlyRoutes];
}
