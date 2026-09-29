/**
 * @jest-environment node
 */
import { describe, it, expect, jest } from '@jest/globals';
import { createReadFetcher } from '../read-data';

function make(body: unknown, status = 200) {
    const calls: { url: URL; init?: RequestInit }[] = [];
    const fetch = jest.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: new URL(url), init });
        return new Response(JSON.stringify(body), { status });
    });
    return { f: createReadFetcher({ baseUrl: 'https://m.test/', apiKey: 'k', fetch }), calls };
}

describe('createReadFetcher', () => {
    it('getDynastyFacet：GET works 索引，只取有整理本或全文的非草稿，带鉴权头', async () => {
        const { f, calls } = make({ hits: [], facetDistribution: { dynasty: { 明: 3 } } });
        expect(await f.getDynastyFacet()).toEqual({ 明: 3 });
        const c = calls[0];
        expect(c.url.pathname).toBe('/indexes/works/search');
        expect(c.url.searchParams.get('facets')).toBe('dynasty');
        expect(c.url.searchParams.get('filter')).toBe('is_draft = false AND (has_collated = true OR has_text = true)');
        expect(c.init?.method).toBe('GET');
        expect((c.init?.headers as Record<string, string>).Authorization).toBe('Bearer k');
    });

    it('getCollated / getBooks：转成卡片', async () => {
        const { f, calls } = make({ hits: [{ id: 'w1', title: '易', author: '某', dynasty: '周', juan_count: 2, has_collated: true, has_text: false }] });
        expect(await f.getCollated()).toEqual([
            { id: 'w1', title: '易', author: '某', dynasty: '周', juanCount: 2, hasCollated: true, hasText: false },
        ]);
        expect(calls[0].url.searchParams.get('filter')).toBe('is_draft = false AND has_collated = true');
        await f.getBooks();
        expect(calls[1].url.pathname).toBe('/indexes/books/search');
    });

    it('getDynastyPage：offset／limit 按页算，超出 1000 条上限不发请求', async () => {
        const { f, calls } = make({ hits: [] });
        await f.getDynastyPage('明', 3);
        expect(calls[0].url.searchParams.get('offset')).toBe('60');
        expect(calls[0].url.searchParams.get('limit')).toBe('30');
        expect(calls[0].url.searchParams.get('filter')).toContain('dynasty = "明"');
        await f.getDynastyPage('明', 34);
        expect(calls[1].url.searchParams.get('limit')).toBe('10');
        expect(await f.getDynastyPage('明', 35)).toEqual([]);
        expect(calls).toHaveLength(2);
    });

    it('5xx 抛错，不当成空数据', async () => {
        const { f } = make({}, 503);
        await expect(f.getDynastyFacet()).rejects.toThrow('HTTP 503');
    });
});
