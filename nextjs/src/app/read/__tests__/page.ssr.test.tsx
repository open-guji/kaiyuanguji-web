/**
 * @jest-environment node
 *
 * 阅读首页服务端（overview#267 第 16 项）：首页列整理本与朝代入口，朝代页列作品并分页，
 * 参数不对／朝代不存在／页码越界真 404，没配 Meili 显示提示不 404，取数出错抛错。
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

const f = {
    getDynastyFacet: jest.fn<() => Promise<Record<string, number>>>(),
    getCollated: jest.fn<() => Promise<unknown[]>>(),
    getBooks: jest.fn<() => Promise<unknown[]>>(),
    getDynastyPage: jest.fn<(d: string, p: number) => Promise<unknown[]>>(),
};
let configured = true;
jest.mock('../read-data', () => ({ getReadFetcher: () => (configured ? f : null) }));
jest.mock('next/navigation', () => ({ notFound: () => { throw new Error('NEXT_NOT_FOUND'); } }));
jest.mock('@/components/layout/LayoutWrapper', () => ({ children }: { children: unknown }) => children);

const card = (id: string, title: string, over = {}) => ({ id, title, hasCollated: false, hasText: true, ...over });

async function meta(sp: Record<string, string>) {
    const { generateMetadata } = await import('../page.ssr');
    return generateMetadata({ searchParams: Promise.resolve(sp) });
}
async function html(sp: Record<string, string>) {
    const { default: Route } = await import('../page.ssr');
    return renderToStaticMarkup((await Route({ searchParams: Promise.resolve(sp) })) as ReactElement);
}

beforeEach(() => {
    configured = true;
    Object.values(f).forEach((m) => m.mockReset());
    f.getDynastyFacet.mockResolvedValue({ 明: 65, 唐: 2 });
    f.getCollated.mockResolvedValue([card('w1', '易經', { hasCollated: true })]);
    f.getBooks.mockResolvedValue([card('b1', '某書')]);
    f.getDynastyPage.mockImplementation(async (_d, p) => (p === 2 ? [card('w9', '第二頁書')] : [card('w2', '明書')]));
});

describe('阅读首页 page.ssr', () => {
    it('首页：整理本与书本全部列出，朝代入口带数量，链接是真链接', async () => {
        const h = await html({});
        expect(h).toContain('<h1');
        expect(h).toContain('整理本（1 部）');
        expect(h).toContain('href="/read/w1?kind=collated"');
        expect(h).toContain('href="/read/b1?kind=fulltext"');
        expect(h).toContain('href="/read?dynasty=%E5%94%90"');
        expect(h).toContain('>唐');
        expect(h.indexOf('唐')).toBeLessThan(h.indexOf('明'));
        expect(f.getDynastyPage).not.toHaveBeenCalled();
    });

    it('朝代页：本页作品、上下页链接、canonical 与标题', async () => {
        const h = await html({ dynasty: '明', page: '2' });
        expect(h).toContain('第二');
        expect(h).toContain('第 2 / 3 页');
        expect(h).toContain('rel="prev"');
        expect(h).toContain('rel="next"');
        expect(await html({ dynasty: '明', page: '3' })).not.toContain('rel="next"');
        expect(f.getDynastyPage).toHaveBeenCalledWith('明', 2);
        const m = await meta({ dynasty: '明', page: '2' });
        expect(m.title).toBe('明代作品（第2页） - 阅读');
        expect(m.alternates?.canonical).toBe('/read?dynasty=%E6%98%8E&page=2');
        expect((await meta({})).alternates?.canonical).toBe('/read');
    });

    it('超过 1000 条的朝代提示改用搜索', async () => {
        f.getDynastyFacet.mockResolvedValue({ 明: 2630 });
        expect(await html({ dynasty: '明' })).toContain('只能翻到前 1000 部');
    });

    it('404：参数不对、朝代不在分组里、页码越界', async () => {
        await expect(html({ dynasty: 'a"b' })).rejects.toThrow('NEXT_NOT_FOUND');
        await expect(html({ dynasty: '清' })).rejects.toThrow('NEXT_NOT_FOUND');
        await expect(html({ dynasty: '明', page: '4' })).rejects.toThrow('NEXT_NOT_FOUND');
        expect((await meta({ dynasty: '清' })).robots).toEqual({ index: false, follow: false });
    });

    it('没配 Meili：提示暂时无法加载，不 404', async () => {
        configured = false;
        expect(await html({})).toContain('暂时无法加载');
    });

    it('取数出错抛错，不当 404 或空页', async () => {
        f.getDynastyFacet.mockRejectedValue(new Error('meili HTTP 503'));
        await expect(html({})).rejects.toThrow('HTTP 503');
    });
});
