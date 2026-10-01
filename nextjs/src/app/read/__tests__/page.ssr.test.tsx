/**
 * @jest-environment node
 *
 * 阅读首页服务端（overview#267 第 16 项）：首页列整理本、书本与四部入口，节点页列作品并分页，
 * 参数不对／节点不存在／页码越界真 404，这一版没有索引首页显示「正在准备」不 404，取数出错抛错。
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

const mockTree = jest.fn<() => Promise<unknown>>();
const mockFeatured = jest.fn<() => Promise<unknown>>();
const mockPage = jest.fn<(node: string, page: number) => Promise<unknown>>();
jest.mock('../read-data', () => ({
    getReadTreeServer: () => mockTree(),
    getReadFeaturedServer: () => mockFeatured(),
    getReadPageServer: (n: string, p: number) => mockPage(n, p),
}));
jest.mock('next/navigation', () => ({ notFound: () => { throw new Error('NEXT_NOT_FOUND'); } }));
jest.mock('@/components/layout/LayoutWrapper', () => ({ children }: { children: unknown }) => children);

const TREE = [
    { id: 'cjing', label: '經部', count: 1 },
    { id: 'cshi', label: '史部', count: 45, children: [{ id: 'czheng', label: '正史類', count: 45 }] },
    { id: 'unclassified', label: '未分類', count: 2 },
];
const card = (id: string, title: string, over = {}) => ({ id, title, ...over });

async function meta(sp: Record<string, string>) {
    const { generateMetadata } = await import('../page.ssr');
    return generateMetadata({ searchParams: Promise.resolve(sp) });
}
async function html(sp: Record<string, string>) {
    const { default: Route } = await import('../page.ssr');
    return renderToStaticMarkup((await Route({ searchParams: Promise.resolve(sp) })) as ReactElement);
}

beforeEach(() => {
    mockTree.mockReset().mockResolvedValue(TREE);
    mockFeatured.mockReset().mockResolvedValue({
        collated: [card('w1', '易經', { collated: true, juan: 3, authors: [{ name: '某', dynasty: '周' }] })],
        books: [card('b1', '某書'), card('b2', '某書', { edition: '甲戌本' }), card('b3', '某書', { edition: '庚辰本' })],
    });
    mockPage.mockReset().mockImplementation(async (node, page) =>
        node === 'czheng' && page === 2 ? [card('w9', '第二頁書')] : (node === 'czheng' || node === 'cshi') ? [card('w2', '史記', { collated: true })] : null);
});

describe('阅读首页 page.ssr', () => {
    it('首页：整理本与书本全部列出，四部入口带数量，链接是真链接', async () => {
        const h = await html({});
        expect(h).toContain('<h1');
        expect(h).toContain('整理本（1 部）');
        expect(h).toContain('书本全文（3 部）');
        expect(h).toContain('href="/read/w1"');
        expect(h).toContain('href="/read/b1"');
        expect(h).toContain('href="/read?node=cshi"');
        expect(h).toContain('史部');
        expect(h).toContain('3卷');
        // 同名书靠版本名分辨（简体直出）
        expect(h).toContain('甲戌本');
        expect(h).toContain('庚辰本');
        expect(h.match(/某书/g)).toHaveLength(3);
        expect(mockPage).not.toHaveBeenCalled();
        expect((await meta({})).alternates?.canonical).toBe('/read');
    });

    it('节点页：本页作品、上下页、子分类、canonical 与标题', async () => {
        const h = await html({ node: 'czheng', page: '2' });
        expect(h).toContain('第二');
        expect(h).toContain('第 2 / 3 页');
        expect(h).toContain('rel="prev"');
        expect(h).toContain('rel="next"');
        expect(mockPage).toHaveBeenCalledWith('czheng', 2);
        const top = await html({ node: 'cshi' });
        expect(top).toContain('href="/read?node=czheng"'); // 子分类
        expect(top).toContain('aria-current="true"'); // 当前部
        const m = await meta({ node: 'czheng', page: '2' });
        expect(m.title).toBe('史部·正史類（第2页） - 阅读');
        expect(m.alternates?.canonical).toBe('/read?node=czheng&page=2');
    });

    it('404：参数不对、节点不存在、页码越界、树上有页文件没有', async () => {
        await expect(html({ node: '../x' })).rejects.toThrow('NEXT_NOT_FOUND');
        await expect(html({ node: 'nope' })).rejects.toThrow('NEXT_NOT_FOUND');
        await expect(html({ node: 'czheng', page: '4' })).rejects.toThrow('NEXT_NOT_FOUND');
        await expect(html({ node: 'cjing' })).rejects.toThrow('NEXT_NOT_FOUND'); // mockPage 返回 null
        await expect(html({ page: '2' })).rejects.toThrow('NEXT_NOT_FOUND');
        expect((await meta({ node: 'nope' })).robots).toEqual({ index: false, follow: false });
    });

    it('这一版数据还没有阅读索引：首页显示正在准备（不 404），节点页 404', async () => {
        mockTree.mockResolvedValue(null);
        expect(await html({})).toContain('正在准备');
        await expect(html({ node: 'cshi' })).rejects.toThrow('NEXT_NOT_FOUND');
    });

    it('取数出错抛错，不当 404 或空页', async () => {
        mockTree.mockRejectedValue(new Error('HTTP 503'));
        await expect(html({})).rejects.toThrow('HTTP 503');
    });
});
