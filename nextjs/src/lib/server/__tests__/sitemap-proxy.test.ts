/**
 * @jest-environment node
 *
 * 条目 sitemap 路由代理（overview#470 P1）：名字白名单、上游地址、<loc> 换成本站、各种失败的状态码。
 */
import { describe, it, expect, jest } from '@jest/globals';
import {
  STORED_SITE, isSitemapName, sitemapNameFromPath, sitemapUpstreamUrl, rewriteSitemapSite, fetchSitemap,
} from '../sitemap-proxy';

const XML = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n<url><loc>${STORED_SITE}/item/abc123</loc></url>\n<url><loc>${STORED_SITE}/item/def456</loc><lastmod>2026-10-01</lastmod></url>\n</urlset>\n`;

function okFetch(body: string, status = 200) {
  const calls: string[] = [];
  const f = jest.fn(async (url: string) => {
    calls.push(url);
    return { ok: status >= 200 && status < 300, status, text: async () => body } as Response;
  });
  return Object.assign(f, { calls }) as unknown as typeof fetch & { calls: string[] };
}

describe('名字白名单', () => {
  it('索引、四类分片、节点页分片可以', () => {
    for (const n of ['sitemap-index', 'work-001', 'book-012', 'collection-001', 'entity-003', 'nodes-001', 'work-1000']) expect(isSitemapName(n)).toBe(true);
  });
  it('路径拼接、别的前缀、位数不对、带后缀的一律不行', () => {
    for (const n of ['', '..', 'work-1', 'work-01', 'other-001', 'work-001.xml', '../latest', 'work-001/x', 'nodes-002', 'sitemap']) expect(isSitemapName(n)).toBe(false);
  });
});

describe('sitemapNameFromPath', () => {
  it('/sitemap-index.xml 与 /sitemaps/<名>.xml', () => {
    expect(sitemapNameFromPath('/sitemap-index.xml')).toBe('sitemap-index');
    expect(sitemapNameFromPath('/sitemaps/work-001.xml')).toBe('work-001');
    expect(sitemapNameFromPath('/sitemaps/nodes-001.xml')).toBe('nodes-001');
  });
  it('静态页 /sitemap.xml、不认识的名字、子目录、无后缀都是 null（交给原来的处理）', () => {
    for (const p of ['/sitemap.xml', '/sitemaps/x.xml', '/sitemaps/work-001', '/sitemaps/a/work-001.xml', '/sitemaps/', '/robots.txt', '/sitemap-index.xml/']) {
      expect(sitemapNameFromPath(p)).toBeNull();
    }
  });
});

describe('地址与改写', () => {
  it('上游地址在数据前缀的 sitemaps/ 下，base 末尾斜杠不影响', () => {
    expect(sitemapUpstreamUrl('https://data.kaiyuanguji.com', 'work-001')).toBe('https://data.kaiyuanguji.com/sitemaps/work-001.xml');
    expect(sitemapUpstreamUrl('https://data.kaiyuanguji.com/', 'sitemap-index')).toBe('https://data.kaiyuanguji.com/sitemaps/sitemap-index.xml');
  });
  it('rewriteSitemapSite：只换 <loc> 开头的站点，其余内容不动；相同站点原样返回', () => {
    const out = rewriteSitemapSite(XML, STORED_SITE, 'https://staging.kaiyuanguji.com/');
    expect(out).toContain('<loc>https://staging.kaiyuanguji.com/item/abc123</loc>');
    expect(out).not.toContain('https://www.kaiyuanguji.com');
    expect(out).toContain('<lastmod>2026-10-01</lastmod>');
    expect(rewriteSitemapSite(XML, STORED_SITE, STORED_SITE)).toBe(XML);
  });
  it('正文里别处出现的站点地址（不在 <loc> 开头）不换', () => {
    const xml = `<?xml version="1.0"?><x>${STORED_SITE}/a</x><loc>${STORED_SITE}/b</loc>`;
    const out = rewriteSitemapSite(xml, STORED_SITE, 'https://s.example.com');
    expect(out).toContain(`<x>${STORED_SITE}/a</x>`);
    expect(out).toContain('<loc>https://s.example.com/b</loc>');
  });
});

describe('fetchSitemap', () => {
  const base = 'https://data.example.com';
  it('取回并换成本站地址；请求的是数据前缀 sitemaps/ 下的那一份', async () => {
    const f = okFetch(XML);
    const r = await fetchSitemap({ base, name: 'work-001', site: 'https://staging.kaiyuanguji.com', fetchImpl: f });
    expect(r).toEqual({ ok: true, xml: XML.split(`${STORED_SITE}/`).join('https://staging.kaiyuanguji.com/') });
    expect(f.calls).toEqual(['https://data.example.com/sitemaps/work-001.xml']);
  });
  it('名字不在白名单：不发请求，直接 404', async () => {
    const f = okFetch(XML);
    const r = await fetchSitemap({ base, name: '../latest', site: STORED_SITE, fetchImpl: f });
    expect(r).toMatchObject({ ok: false, status: 404 });
    expect(f).not.toHaveBeenCalled();
  });
  it('上游 404（数据还没上线这一份）→ 404；其它错误码、网络错、超时 → 502', async () => {
    expect(await fetchSitemap({ base, name: 'work-001', site: STORED_SITE, fetchImpl: okFetch('', 404) })).toMatchObject({ ok: false, status: 404 });
    expect(await fetchSitemap({ base, name: 'work-001', site: STORED_SITE, fetchImpl: okFetch('', 500) })).toMatchObject({ ok: false, status: 502 });
    const boom = (async () => { throw new Error('network down'); }) as unknown as typeof fetch;
    expect(await fetchSitemap({ base, name: 'work-001', site: STORED_SITE, fetchImpl: boom })).toMatchObject({ ok: false, status: 502, reason: 'network down' });
    const hang = ((_u: string, init?: RequestInit) => new Promise((_, rej) => { init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))); })) as unknown as typeof fetch;
    expect(await fetchSitemap({ base, name: 'work-001', site: STORED_SITE, fetchImpl: hang, timeoutMs: 20 })).toMatchObject({ ok: false, status: 502 });
  });
  it('带 xml 声明的错误页／半截的 sitemap（没有以 </urlset> 或 </sitemapindex> 收尾）→ 502', async () => {
    for (const bad of ['<?xml version="1.0"?><error>oops</error>', XML.slice(0, XML.length - 20), `${XML}garbage`]) {
      const r = await fetchSitemap({ base, name: 'work-001', site: STORED_SITE, fetchImpl: okFetch(bad) });
      expect(r).toMatchObject({ ok: false, status: 502 });
    }
    const idx = '<?xml version="1.0"?>\n<sitemapindex xmlns="x"><sitemap><loc>https://www.kaiyuanguji.com/sitemap.xml</loc></sitemap></sitemapindex>\n';
    expect(await fetchSitemap({ base, name: 'sitemap-index', site: STORED_SITE, fetchImpl: okFetch(idx) })).toMatchObject({ ok: true });
  });
  it('上游回的不是 xml（例如 CDN 错误页）→ 502，不当 sitemap 缓存', async () => {
    const r = await fetchSitemap({ base, name: 'work-001', site: STORED_SITE, fetchImpl: okFetch('<html>oops</html>') });
    expect(r).toMatchObject({ ok: false, status: 502, reason: 'upstream is not xml' });
  });
});
