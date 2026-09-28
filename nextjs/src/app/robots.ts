import { MetadataRoute } from 'next';
import { SITE_URL, IS_STAGING } from '@/lib/constants';

export const dynamic = 'force-static';

export default function robots(): MetadataRoute.Robots {
    // T1 测试站：全站不许被抓、不发 sitemap（内容与正式站重复，收录了也没用）
    if (IS_STAGING) {
        return {
            rules: {
                userAgent: '*',
                disallow: '/',
            },
        };
    }
    return {
        rules: {
            userAgent: '*',
            allow: '/',
            disallow: '/private/',
        },
        // 全栈构建的 /sitemap.xml 只列静态页，条目在 /sitemaps/* 分片里，由 sitemap-index.xml 汇总
        sitemap: process.env.KYG_RENDER_MODE === 'fullstack'
            ? `${SITE_URL}/sitemap-index.xml`
            : `${SITE_URL}/sitemap.xml`,
    };
}
