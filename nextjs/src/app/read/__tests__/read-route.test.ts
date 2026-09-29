import { describe, it, expect } from '@jest/globals';
import {
    isTruncated,
    isValidDynasty,
    parseReadQuery,
    readCardHref,
    readDescription,
    readHomeHref,
    readPageCount,
    readTitle,
    sortDynasties,
} from '../read-route';

describe('parseReadQuery', () => {
    it('无参数＝首页；朝代与页码解析', () => {
        expect(parseReadQuery({})).toEqual({ dynasty: undefined, page: 1 });
        expect(parseReadQuery({ dynasty: '明', page: '3' })).toEqual({ dynasty: '明', page: 3 });
        expect(parseReadQuery({ dynasty: ['明', '清'] })).toEqual({ dynasty: '明', page: 1 });
    });
    it('形态不对＝null（404）：乱码朝代、非正整数页码、没有朝代却翻页', () => {
        expect(parseReadQuery({ dynasty: 'a"b' })).toBeNull();
        expect(parseReadQuery({ dynasty: '明" OR x' })).toBeNull();
        expect(parseReadQuery({ dynasty: '' })).toBeNull();
        expect(parseReadQuery({ dynasty: '明', page: '0' })).toBeNull();
        expect(parseReadQuery({ dynasty: '明', page: 'x' })).toBeNull();
        expect(parseReadQuery({ page: '2' })).toBeNull();
    });
});

describe('地址与页数', () => {
    it('第 1 页不带 page，朝代编码', () => {
        expect(readHomeHref()).toBe('/read');
        expect(readHomeHref('明')).toBe('/read?dynasty=%E6%98%8E');
        expect(readHomeHref('明', 2)).toBe('/read?dynasty=%E6%98%8E&page=2');
    });
    it('页数受 Meili 1000 条上限限制', () => {
        expect(readPageCount(0)).toBe(1);
        expect(readPageCount(30)).toBe(1);
        expect(readPageCount(31)).toBe(2);
        expect(readPageCount(2630)).toBe(34);
        expect(isTruncated(1000)).toBe(false);
        expect(isTruncated(1001)).toBe(true);
    });
    it('有整理本读整理本，否则读全文', () => {
        expect(readCardHref({ id: 'd1', hasCollated: true })).toBe('/read/d1?kind=collated');
        expect(readCardHref({ id: 'd1', hasCollated: false })).toBe('/read/d1?kind=fulltext');
    });
    it('标题与描述', () => {
        expect(readTitle({ page: 1 })).toBe('阅读');
        expect(readTitle({ dynasty: '明', page: 2 })).toBe('明代作品（第2页） - 阅读');
        expect(readDescription({ dynasty: '明', page: 1 }, 2630)).toContain('共 2630 部');
    });
    it('朝代白名单', () => {
        expect(isValidDynasty('南朝宋')).toBe(true);
        expect(isValidDynasty('a')).toBe(false);
    });
});

describe('sortDynasties', () => {
    it('按朝代先后；表外靠后按数量降序；数量为 0 丢掉', () => {
        const r = sortDynasties({ 清: 3, 唐: 2, 朝鮮: 4, 日本: 5, 明: 0, 先秦: 1 });
        expect(r.map((d) => d.name)).toEqual(['先秦', '唐', '清', '日本', '朝鮮']);
    });
});
