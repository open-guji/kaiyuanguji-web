/**
 * @jest-environment node
 *
 * 古籍总目页服务端（N4b）：每个节点页各有 title 与 canonical；节点／页码不存在真 404；
 * 索引读不到（网络错）抛错，不当 404；首屏 HTML 里就有作品卡。
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

const mockTree = jest.fn<() => Promise<unknown>>();
const mockPage = jest.fn<(node: string, page: number) => Promise<unknown>>();
jest.mock('../catalog-data', () => ({
    getCatalogTreeServer: () => mockTree(),
    getCatalogPageServer: (node: string, page: number) => mockPage(node, page),
}));
jest.mock('next/navigation', () => ({
    notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
    useRouter: () => ({ push: () => {} }),
}));
jest.mock('@/components/layout/LayoutWrapper', () => ({ children }: { children: unknown }) => children);

const TREE = [
    { id: 'cjing', label: '經部', count: 1 },
    { id: 'cshi', label: '史部', count: 25, children: [{ id: 'czhengshi', label: '正史類', count: 25 }] },
    { id: 'unclassified', label: '未分類', count: 1 },
];
const card = (i: number) => ({ id: `w${i}`, title: `書${i}`, classification: ['史部', '正史類'] });

async function meta(sp: Record<string, string>) {
    const { generateMetadata } = await import('../page.ssr');
    return generateMetadata({ searchParams: Promise.resolve(sp) });
}
async function html(sp: Record<string, string>) {
    const { default: CatalogRoute } = await import('../page.ssr');
    return renderToStaticMarkup((await CatalogRoute({ searchParams: Promise.resolve(sp) })) as ReactElement);
}

beforeEach(() => {
    mockTree.mockReset();
    mockPage.mockReset();
    mockTree.mockResolvedValue(TREE);
    mockPage.mockImplementation(async (node, page) =>
        node === 'czhengshi' && page === 2 ? [card(21), card(22)] : node === 'czhengshi' && page === 1 ? [card(1)] : null);
});

describe('古籍总目 page.ssr', () => {
    it('目录是分支页，有页脚（9-30 反馈，overview#322；取代 overview#267 的「不要页脚」）', async () => {
        const { default: CatalogRoute } = await import('../page.ssr');
        const el = (await CatalogRoute({ searchParams: Promise.resolve({ node: 'czhengshi' }) })) as ReactElement<{ hideFooter?: boolean }>;
        expect(el.props.hideFooter).toBeFalsy();
    });

    it('节点第 1 页：canonical 不带 page，标题带分类路径', async () => {
        const m = await meta({ node: 'czhengshi' });
        expect(m.title).toBe('史部·正史類 - 古籍总目');
        expect(m.alternates?.canonical).toBe('/catalog?node=czhengshi');
        expect(m.robots).toBeUndefined();
    });

    it('第 2 页：各有 canonical；首屏 HTML 带作品卡、分页与条目链接', async () => {
        const m = await meta({ node: 'czhengshi', page: '2' });
        expect(m.alternates?.canonical).toBe('/catalog?node=czhengshi&page=2');
        expect(m.title).toBe('史部·正史類（第2页） - 古籍总目');
        const h = await html({ node: 'czhengshi', page: '2' });
        expect(mockPage).toHaveBeenCalledWith('czhengshi', 2);
        expect(h).toContain('href="/item/w21"');
        // book-index-ui 0.11.0 起首帧（含服务端 HTML）就是简体：書22 → 书22
        expect(h).toContain('书22');
        // 分页是真链接（组件的 pageHref）
        expect(h).toContain('href="/catalog?node=czhengshi"');
        expect(h).toContain('正史类');
    });

    it('不带 node：落到经部，canonical 指向经部节点页', async () => {
        mockPage.mockResolvedValue([card(9)]);
        const m = await meta({});
        expect(m.alternates?.canonical).toBe('/catalog?node=cjing');
        expect(await html({})).toContain('书9');
    });

    it('node=all（组件的「全部」行）：待用户定，先落到默认节点，不 404', async () => {
        mockPage.mockResolvedValue([card(9)]);
        const m = await meta({ node: 'all' });
        expect(m.alternates?.canonical).toBe('/catalog?node=cjing');
        expect(await html({ node: 'all' })).toContain('书9');
    });

    it('节点不存在、页码越界、乱填：真 404 且 noindex', async () => {
        for (const sp of [{ node: 'cnope' }, { node: 'czhengshi', page: '3' }, { page: 'x' }, { node: '../../etc' }]) {
            const m = await meta(sp);
            expect(m.robots).toEqual({ index: false, follow: false });
            expect(m.alternates).toBeUndefined();
            await expect(html(sp)).rejects.toThrow('NEXT_NOT_FOUND');
        }
    });

    it('这一版数据没有总目索引：404', async () => {
        mockTree.mockResolvedValue(null);
        await expect(html({ node: 'czhengshi' })).rejects.toThrow('NEXT_NOT_FOUND');
    });

    it('索引读不到（网络错）：抛错，不当 404', async () => {
        mockTree.mockRejectedValue(new Error('HTTP 502'));
        await expect(html({ node: 'czhengshi' })).rejects.toThrow('HTTP 502');
    });
});
