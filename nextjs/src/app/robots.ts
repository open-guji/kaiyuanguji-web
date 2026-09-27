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
        sitemap: `${SITE_URL}/sitemap.xml`,
    };
}
