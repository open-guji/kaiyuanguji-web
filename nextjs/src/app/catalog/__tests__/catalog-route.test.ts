/**
 * 古籍总目地址约定（N4b）：查询串解析、节点与页码落实、canonical 与标题。
 */
import { describe, it, expect } from '@jest/globals';
import {
    catalogDescription,
    catalogHref,
    catalogTitle,
    findNode,
    pageCountOf,
    parseCatalogQuery,
    resolveCatalog,
    type CatalogNode,
} from '../catalog-route';

const TREE: CatalogNode[] = [
    { id: 'cjing', label: '經部', count: 3 },
    {
        id: 'cshi', label: '史部', count: 45,
        children: [
            { id: 'czhengshi', label: '正史類', count: 21 },
            { id: 'cdili', label: '地理類', count: 4, children: [{ id: 'cdu', label: '都會郡縣之屬', count: 1 }] },
        ],
    },
    { id: 'unclassified', label: '未分類', count: 20 },
];

describe('parseCatalogQuery', () => {
    it('node 与 page 都可省；page 默认 1', () => {
        expect(parseCatalogQuery({})).toEqual({ node: undefined, page: 1 });
        expect(parseCatalogQuery({ node: 'cshi', page: '3' })).toEqual({ node: 'cshi', page: 3 });
        expect(parseCatalogQuery({ node: ['cshi', 'x'] })).toEqual({ node: 'cshi', page: 1 });
    });
    it('形态不对：null（404）', () => {
        for (const sp of [{ page: '0' }, { page: '-1' }, { page: '1.5' }, { page: 'abc' }, { page: '01' },
            { node: '../x' }, { node: '' }, { node: 'C大寫' }]) {
            expect(parseCatalogQuery(sp)).toBeNull();
        }
    });
});

describe('resolveCatalog', () => {
    it('找到深层节点，带路径与页数', () => {
        const r = resolveCatalog(TREE, { node: 'cdu', page: 1 })!;
        expect(r.path.map((n) => n.id)).toEqual(['cshi', 'cdili', 'cdu']);
        expect(r.pageCount).toBe(1);
        expect(resolveCatalog(TREE, { node: 'czhengshi', page: 2 })!.pageCount).toBe(2);
    });
    it('不带 node 落到第一个节点', () => {
        expect(resolveCatalog(TREE, { page: 1 })!.node.id).toBe('cjing');
    });
    it('节点不存在、页码越界：null', () => {
        expect(resolveCatalog(TREE, { node: 'cnope', page: 1 })).toBeNull();
        expect(resolveCatalog(TREE, { node: 'czhengshi', page: 3 })).toBeNull();
        expect(resolveCatalog(TREE, { node: 'unclassified', page: 2 })).toBeNull();
        expect(resolveCatalog([], { page: 1 })).toBeNull();
    });
    it('findNode 找不到返回 null', () => {
        expect(findNode(TREE, 'x')).toBeNull();
    });
    it('pageCountOf：空节点也有 1 页', () => {
        expect(pageCountOf(0)).toBe(1);
        expect(pageCountOf(20)).toBe(1);
        expect(pageCountOf(21)).toBe(2);
    });
});

describe('canonical 与标题', () => {
    it('第 1 页不带 page', () => {
        expect(catalogHref('czhengshi')).toBe('/catalog?node=czhengshi');
        expect(catalogHref('czhengshi', 1)).toBe('/catalog?node=czhengshi');
        expect(catalogHref('czhengshi', 2)).toBe('/catalog?node=czhengshi&page=2');
    });
    it('标题带分类路径与页码', () => {
        const r1 = resolveCatalog(TREE, { node: 'czhengshi', page: 1 })!;
        const r2 = resolveCatalog(TREE, { node: 'czhengshi', page: 2 })!;
        expect(catalogTitle(r1)).toBe('史部·正史類 - 古籍总目');
        expect(catalogTitle(r2)).toBe('史部·正史類（第2页） - 古籍总目');
        expect(catalogDescription(r2)).toBe('古籍总目 史部 › 正史類：共 21 部作品，第 2／2 页。');
        expect(catalogDescription(resolveCatalog(TREE, { node: 'unclassified', page: 1 })!)).toBe('古籍总目 未分類：共 20 部作品。');
    });
});
