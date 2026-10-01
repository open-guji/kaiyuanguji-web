/**
 * @jest-environment node
 *
 * 阅读首页服务端（overview#267 第 16 项、#308）：首页是 ReadHomeView 各分区，节点页、年代页列条目并分页，
 * 参数不对／节点或年代段不存在／页码越界真 404，这一版没有索引首页显示「正在准备」不 404，取数出错抛错。
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

const mockTree = jest.fn<() => Promise<unknown>>();
const mockSections = jest.fn<() => Promise<unknown>>();
const mockPage = jest.fn<(node: string, page: number) => Promise<unknown>>();
const mockPeriodPage = jest.fn<(key: string, page: number) => Promise<unknown>>();
jest.mock('../read-data', () => ({
    getReadTreeServer: () => mockTree(),
    getReadSectionsServer: () => mockSections(),
    getReadPageServer: (n: string, p: number) => mockPage(n, p),
    getReadPeriodPageServer: (k: string, p: number) => mockPeriodPage(k, p),
}));
jest.mock('next/navigation', () => ({ notFound: () => { throw new Error('NEXT_NOT_FOUND'); } }));
jest.mock('@/components/layout/LayoutWrapper', () => ({ children }: { children: unknown }) => children);

const TREE = [
    { id: 'cjing', label: '經部', count: 1 },
    { id: 'cshi', label: '史部', count: 45, children: [{ id: 'czheng', label: '正史類', count: 45 }] },
    { id: 'unclassified', label: '未分類', count: 2 },
];
const card = (id: string, title: string, over = {}) => ({ id, title, ...over });
const SECTIONS = {
    counts: { readable: 1234, works: 1200, books: 34, pieces: 56 },
    picks: [card('b1', '脂硯齋重評石頭記', { edition: '甲戌本', blurb: '脂本最早', slip: '石頭記', type_label: '小說' })],
    topics: [
        { key: 'shizhi', label: '史志目錄', shelf: true, items: [card('w5', '漢書藝文志', { period_of: '漢', orig: true })] },
        { key: 'bibliography', label: '書目與考證', items: [card('w1', '直齋書錄解題', { text_count: 2, authors: [{ name: '陳振孫', dynasty: '南宋' }] })] },
    ],
    famous: [{ title: '紅樓夢', text_count: 2, systems: [{ label: '脂本', items: [{ id: 'b1', short: '甲戌本', title: '石頭記' }, { id: 'b2', short: '庚辰本', title: '石頭記' }] }] }],
    bu: [{ id: 'cshi', label: '史部', count: 45, children_total: 1, top: [{ id: 'czheng', label: '正史類', count: 45 }] }],
    unclassified: 2,
    periods: [{ key: 'song', label: '宋', count: 45 }, { key: 'qing', label: '清', count: 3 }],
    period_unknown: 7,
    pieces: { count: 56, authors: [{ name: '韓愈', dynasty: '唐', count: 3, items: [card('p1', '師說', { subtype: 'article' })] }] },
};

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
    mockSections.mockReset().mockResolvedValue(SECTIONS);
    mockPage.mockReset().mockImplementation(async (node, page) =>
        node === 'czheng' && page === 2 ? [card('w9', '第二頁書')] : (node === 'czheng' || node === 'cshi') ? [card('w2', '史記', { collated: true, text_count: 3 })] : null);
    mockPeriodPage.mockReset().mockImplementation(async (key, page) =>
        key === 'song' && page === 3 ? [card('w8', '宋書末頁')] : key === 'song' ? [card('w7', '夢溪筆談', { authors: [{ name: '沈括', dynasty: '北宋' }] })] : null);
});

/** 正文（去掉 <style> 与标签）里不许出现「整理本」「全文」（用户 10-01） */
const visibleText = (h: string) => h.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, '');

describe('阅读首页 page.ssr', () => {
    it('首页：ReadHomeView 各分区，搜索框、统计，链接都是真链接；史志书架不出（overview#322）', async () => {
        const h = await html({});
        expect(h).toMatch(/<h1[^>]*>阅读<\/h1>/); // 只给读屏
        expect(h).toContain('action="/book-index"');
        expect(h).toContain('1,234');
        for (const t of ['推荐阅读', '专题', '名著与版本', '四部', '按年代', '单篇诗文']) expect(h).toContain(t);
        expect(h).toContain('href="/read/b1"');
        expect(h).toContain('href="/read/w1"');
        expect(h).toContain('href="/read?node=cshi"');
        expect(h).toContain('href="/read?period=song"');
        expect(h).toContain('甲戌本');
        expect(h).not.toContain('href="/read/w5"'); // 书架不在首页
        expect(visibleText(h)).not.toMatch(/整理本|全文/);
        expect(visibleText(h)).not.toContain('站上所有有整理本'); // 导语已删
        expect(mockPage).not.toHaveBeenCalled();
        expect((await meta({})).alternates?.canonical).toBe('/read');
    });

    it('节点页：本页作品、上下页、子分类、canonical 与标题；卡片标「N本」不标整理本', async () => {
        const h = await html({ node: 'czheng', page: '2' });
        expect(h).toContain('第二');
        expect(h).toContain('第 2 / 3 页');
        expect(h).toContain('rel="prev"');
        expect(h).toContain('rel="next"');
        expect(mockPage).toHaveBeenCalledWith('czheng', 2);
        const top = await html({ node: 'cshi' });
        expect(top).toContain('href="/read?node=czheng"'); // 子分类
        expect(top).toContain('aria-current="true"'); // 当前部
        expect(top).toContain('3本');
        expect(visibleText(top)).not.toMatch(/整理本|全文/);
        const m = await meta({ node: 'czheng', page: '2' });
        expect(m.title).toBe('史部·正史类（第2页） - 阅读');
        expect(m.alternates?.canonical).toBe('/read?node=czheng&page=2');
    });

    it('年代页：?period= 分页、年代切换、canonical 与标题', async () => {
        const h = await html({ period: 'song' });
        expect(h).toContain('梦溪笔谈');
        expect(h).toContain('第 1 / 3 页');
        expect(h).toContain('href="/read?period=song&amp;page=2"');
        expect(h).toMatch(/aria-current="true" href="\/read\?period=song"/);
        expect(h).toContain('href="/read?period=qing"');
        expect(h).not.toContain('href="/read?period=ming"'); // 数据里没有的段不列
        expect(mockPeriodPage).toHaveBeenCalledWith('song', 1);
        const last = await html({ period: 'song', page: '3' });
        expect(last).toContain('宋书末页');
        const m = await meta({ period: 'song', page: '2' });
        expect(m.title).toBe('宋（第2页） - 阅读');
        expect(m.alternates?.canonical).toBe('/read?period=song&page=2');
    });

    it('404：参数不对、节点／年代段不存在、页码越界、页文件没有', async () => {
        await expect(html({ node: '../x' })).rejects.toThrow('NEXT_NOT_FOUND');
        await expect(html({ node: 'nope' })).rejects.toThrow('NEXT_NOT_FOUND');
        await expect(html({ node: 'czheng', page: '4' })).rejects.toThrow('NEXT_NOT_FOUND');
        await expect(html({ node: 'cjing' })).rejects.toThrow('NEXT_NOT_FOUND'); // mockPage 返回 null
        await expect(html({ page: '2' })).rejects.toThrow('NEXT_NOT_FOUND');
        await expect(html({ period: 'nope' })).rejects.toThrow('NEXT_NOT_FOUND');
        await expect(html({ period: 'ming' })).rejects.toThrow('NEXT_NOT_FOUND'); // 数据里没有这段
        await expect(html({ period: 'song', page: '4' })).rejects.toThrow('NEXT_NOT_FOUND');
        await expect(html({ period: 'qing' })).rejects.toThrow('NEXT_NOT_FOUND'); // 页文件没有
        await expect(html({ period: 'song', node: 'cshi' })).rejects.toThrow('NEXT_NOT_FOUND');
        expect((await meta({ node: 'nope' })).robots).toEqual({ index: false, follow: false });
    });

    it('这一版数据还没有阅读索引：首页显示正在准备（不 404），节点页、年代页 404', async () => {
        mockTree.mockResolvedValue(null);
        mockSections.mockResolvedValue(null);
        expect(await html({})).toContain('正在准备');
        await expect(html({ node: 'cshi' })).rejects.toThrow('NEXT_NOT_FOUND');
        await expect(html({ period: 'song' })).rejects.toThrow('NEXT_NOT_FOUND');
    });

    it('取数出错抛错，不当 404 或空页', async () => {
        mockSections.mockRejectedValue(new Error('HTTP 503'));
        await expect(html({})).rejects.toThrow('HTTP 503');
        mockTree.mockRejectedValue(new Error('HTTP 502'));
        await expect(html({ node: 'cshi' })).rejects.toThrow('HTTP 502');
    });
});
