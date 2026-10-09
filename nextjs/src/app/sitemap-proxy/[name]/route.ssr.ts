// overview#470 P1：条目 sitemap 的路由代理（见 lib/server/sitemap-proxy.ts）。
//
// 文件名带 .ssr：只在全栈构建里存在。不直接对外——站点上的 /sitemap-index.xml、/sitemaps/<名>.xml 由
// middleware.ssr.ts 改写到这里（只在构建时设了 NEXT_PUBLIC_SITEMAP_PROXY=1 才改写）。
// 数据在数据前缀的 sitemaps/ 下，由数据流程生成上传；<loc> 换成本站地址后回，s-maxage 一小时。
import { NextResponse, type NextRequest } from 'next/server';
import { SITE_URL } from '@/lib/constants';
import { gzipText } from '@/lib/server/gzip-body';
import { defaultItemDataBase } from '@/lib/server/item-data';
import { fetchSitemap, isSitemapName, SITEMAP_CACHE_CONTROL } from '@/lib/server/sitemap-proxy';

export const dynamic = 'force-dynamic';

export async function GET(_req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
    const { name } = await params;
    if (!isSitemapName(name)) return new NextResponse('Not Found', { status: 404 });
    const r = await fetchSitemap({ base: defaultItemDataBase(), name, site: SITE_URL });
    if (!r.ok) {
        // 留一条服务端日志，运维才分得清上游没有这份（404）、超时、还是回了坏内容
        console.warn(`[sitemap-proxy] ${name} 取不到（${r.status}）：${r.reason}`);
        // 错误不缓存：数据上线的空档里取不到，下一次请求就该重取
        return new NextResponse(r.status === 404 ? 'Not Found' : 'Bad Gateway', {
            status: r.status,
            headers: { 'Cache-Control': 'no-store' },
        });
    }
    // 单片约 4 MB 明文：函数输出不会被边缘压缩（overview#487），自己 gzip，网关按客户端头转码。
    // 不压的话契约测试一次取几十片会超时，爬虫取一片也要传 4 MB
    const body = gzipText(r.xml);
    return new NextResponse(new Uint8Array(body), {
        status: 200,
        headers: {
            'Content-Type': 'application/xml; charset=utf-8',
            'Content-Encoding': 'gzip',
            'Content-Length': String(body.length),
            Vary: 'Accept-Encoding',
            'Cache-Control': SITEMAP_CACHE_CONTROL,
        },
    });
}
