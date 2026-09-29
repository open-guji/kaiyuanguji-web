import { describe, it, expect } from '@jest/globals';
import {
    parseReadQuery,
    readCardHref,
    readDescription,
    readHomeHref,
    readPageCount,
    readTitle,
    resolveRead,
    type CatalogNode,
} from '../read-route';

const TREE: CatalogNode[] = [
    { id: 'cjing', label: '經部', count: 3 },
    { id: 'cshi', label: '史部', count: 45, children: [{ id: 'czheng', label: '正史類', count: 45 }] },
    { id: 'unclassified', label: '未分類', count: 1 },
];

describe('parseReadQuery', () => {
    it('无参数＝首页；节点与页码解析', () => {
        expect(parseReadQuery({})).toEqual({ node: undefined, page: 1 });
        expect(parseReadQuery({ node: 'cshi', page: '3' })).toEqual({ node: 'cshi', page: 3 });
        expect(parseReadQuery({ node: ['cshi', 'cjing'] })).toEqual({ node: 'cshi', page: 1 });
    });
    it('形态不对＝null（404）：乱码节点、非正整数页码、没有节点却翻页', () => {
        expect(parseReadQuery({ node: '../x' })).toBeNull();
        expect(parseReadQuery({ node: '史部' })).toBeNull();
        expect(parseReadQuery({ node: '' })).toBeNull();
        expect(parseReadQuery({ node: 'cshi', page: '0' })).toBeNull();
        expect(parseReadQuery({ node: 'cshi', page: 'x' })).toBeNull();
        expect(parseReadQuery({ page: '2' })).toBeNull();
    });
});

describe('resolveRead', () => {
    it('落实节点路径与页数；节点不存在、页码越界＝null', () => {
        const r = resolveRead(TREE, { node: 'czheng', page: 3 })!;
        expect(r.path.map((n) => n.label)).toEqual(['史部', '正史類']);
        expect(r.pageCount).toBe(3);
        expect(resolveRead(TREE, { node: 'czheng', page: 4 })).toBeNull();
        expect(resolveRead(TREE, { node: 'nope', page: 1 })).toBeNull();
    });
});

describe('地址、页数、标题', () => {
    it('第 1 页不带 page', () => {
        expect(readHomeHref()).toBe('/read');
        expect(readHomeHref('cshi')).toBe('/read?node=cshi');
        expect(readHomeHref('cshi', 2)).toBe('/read?node=cshi&page=2');
    });
    it('每页 20 条', () => {
        expect(readPageCount(0)).toBe(1);
        expect(readPageCount(20)).toBe(1);
        expect(readPageCount(21)).toBe(2);
    });
    it('有整理本读整理本，否则读全文', () => {
        expect(readCardHref({ id: 'd1', collated: true })).toBe('/read/d1?kind=collated');
        expect(readCardHref({ id: 'd1' })).toBe('/read/d1?kind=fulltext');
    });
    it('标题与描述', () => {
        const r = resolveRead(TREE, { node: 'czheng', page: 2 })!;
        expect(readTitle()).toBe('阅读');
        expect(readTitle(r)).toBe('史部·正史類（第2页） - 阅读');
        expect(readDescription(r)).toContain('共 45 部');
        expect(readDescription()).toContain('经史子集');
    });
});
