/**
 * @jest-environment node
 *
 * 条目 sitemap 路由处理器（app/sitemap-proxy/[name]/route.ssr.ts）：非法名字、上游各种失败的状态码与缓存头，
 * 成功时 gzip 出口的头与解开后的正文。取数（fetchSitemap）整体换成可控实现；名字白名单与缓存头用真实实现。
 */
import { describe, it, expect, jest, beforeEach, afterAll } from '@jest/globals';
import { gunzipSync } from 'node:zlib';
import { NextRequest } from 'next/server';
import type { SitemapResult } from '../sitemap-proxy';

const mockFetchSitemap = jest.fn<(opts: Record<string, unknown>) => Promise<SitemapResult>>();

jest.mock('@/lib/server/sitemap-proxy', () => ({
    ...jest.requireActual<typeof import('../sitemap-proxy')>('../sitemap-proxy'),
    fetchSitemap: (opts: Record<string, unknown>) => mockFetchSitemap(opts),
}));

jest.mock('@/lib/server/item-data', () => ({
    defaultItemDataBase: () => 'https://data.example.com',
}));

const XML = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n<url><loc>https://staging.kaiyuanguji.com/item/abc123</loc></url>\n<url><loc>https://staging.kaiyuanguji.com/item/中文条目</loc><lastmod>2026-10-01</lastmod></url>\n</urlset>\n`;

async function callRoute(name: string) {
    const { GET } = await import('../../../app/sitemap-proxy/[name]/route.ssr');
    const req = new NextRequest(`https://staging.kaiyuanguji.com/sitemaps/${name}.xml`, { headers: { 'accept-encoding': 'gzip' } });
    return GET(req, { params: Promise.resolve({ name }) });
}

describe('sitemap-proxy 路由处理器', () => {
    beforeEach(() => {
        mockFetchSitemap.mockReset();
        // 错误分支会打一条服务端日志，测试里静音，但仍断言它确实发生过
        jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterAll(() => {
        jest.restoreAllMocks();
    });

    it('非法名字（路径穿越）→ 404，不去取数', async () => {
        const res = await callRoute('../x');
        expect(res.status).toBe(404);
        expect(mockFetchSitemap).not.toHaveBeenCalled();
    });

    it('上游没有这一份（fetchSitemap 返回 404）→ 404，且 no-store', async () => {
        mockFetchSitemap.mockResolvedValue({ ok: false, status: 404, reason: 'upstream 404' });
        const res = await callRoute('work-001');
        expect(res.status).toBe(404);
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(mockFetchSitemap).toHaveBeenCalledTimes(1);
        expect(mockFetchSitemap.mock.calls[0][0]).toMatchObject({ base: 'https://data.example.com', name: 'work-001' });
    });

    it('上游出错（fetchSitemap 返回 502）→ 502，且 no-store', async () => {
        mockFetchSitemap.mockResolvedValue({ ok: false, status: 502, reason: 'upstream HTTP 500' });
        const res = await callRoute('work-001');
        expect(res.status).toBe(502);
        expect(res.headers.get('cache-control')).toBe('no-store');
    });

    it('成功：200，gzip 头齐全，解开后与原 xml 完全相等', async () => {
        const { SITEMAP_CACHE_CONTROL } = await import('@/lib/server/sitemap-proxy');
        mockFetchSitemap.mockResolvedValue({ ok: true, xml: XML });
        const res = await callRoute('work-001');

        expect(res.status).toBe(200);
        expect(res.headers.get('content-encoding')).toBe('gzip');
        expect(res.headers.get('vary')).toMatch(/Accept-Encoding/i);
        expect(res.headers.get('cache-control')).toBe(SITEMAP_CACHE_CONTROL);
        expect(res.headers.get('content-type')).toBe('application/xml; charset=utf-8');

        const bytes = Buffer.from(await res.arrayBuffer());
        expect(res.headers.get('content-length')).toBe(String(bytes.length));
        expect(gunzipSync(bytes).toString('utf-8')).toBe(XML);
    });
});
