/**
 * @jest-environment node
 *
 * N5b：阅读页地址约定（/item/<id>/read?kind=…&key=…&juan=…）与旧入口跳转。
 */
import { describe, it, expect } from '@jest/globals';
import { juanLabel, legacyReaderTarget, parseReaderQuery, readerHref, readerTitle } from '../reader-route';

const WORK = 'd59f20aowb9c'; // 史記（Work）
const ZHIZHAI = 'd59f2htm01du'; // 直齋書錄解題（Work，有整理本）
const BOOK = '988fbiuha8'; // 御定佩文韻府（Book）
const ENTITY = 'hixhd2h9bk4b'; // 孔子（Entity）

describe('parseReaderQuery', () => {
    it('整理本、全文带卷号', () => {
        expect(parseReaderQuery(ZHIZHAI, { kind: 'collated', juan: 'juan/011.json' })).toEqual({ kind: 'collated', juan: 'juan/011.json' });
        expect(parseReaderQuery(BOOK, new URLSearchParams('kind=fulltext&juan=001'))).toEqual({ kind: 'fulltext', juan: '001' });
    });
    it('key 只对全文留下，空值视同没带', () => {
        expect(parseReaderQuery(WORK, { kind: 'fulltext', key: 'wiki-1', juan: '' })).toEqual({ kind: 'fulltext', key: 'wiki-1' });
        expect(parseReaderQuery(WORK, { kind: 'collated', key: 'wiki-1' })).toEqual({ kind: 'collated' });
    });
    it('重复参数取第一个', () => {
        expect(parseReaderQuery(WORK, { kind: ['collated', 'fulltext'] })).toEqual({ kind: 'collated' });
    });
    it('kind 缺省：Work 看整理本，Book 看全文', () => {
        expect(parseReaderQuery(WORK, {})).toEqual({ kind: 'collated' });
        expect(parseReaderQuery(BOOK, {})).toEqual({ kind: 'fulltext' });
    });
    it.each<[string, Record<string, string>]>([
        [WORK, { kind: 'lineage' }],
        [BOOK, { kind: 'collated' }], // Book 没有整理本
        [ENTITY, {}],
        [ENTITY, { kind: 'fulltext' }],
        ['BAD..id', { kind: 'fulltext' }],
    ])('没有这种阅读页 → null：%s %j', (id, sp) => {
        expect(parseReaderQuery(id, sp)).toBeNull();
    });
});

describe('readerHref／readerTitle／juanLabel', () => {
    it('参数顺序固定，collated 不带 key', () => {
        expect(readerHref(WORK, { kind: 'fulltext', juan: '001', key: 'k' })).toBe(`/item/${WORK}/read?kind=fulltext&key=k&juan=001`);
        expect(readerHref(ZHIZHAI, { kind: 'collated', key: 'k', juan: 'juan/011.json' })).toBe(`/item/${ZHIZHAI}/read?kind=collated&juan=juan%2F011.json`);
        expect(readerHref(BOOK, { kind: 'fulltext' })).toBe(`/item/${BOOK}/read?kind=fulltext`);
    });
    it('卷名', () => {
        expect(juanLabel('juan/011.json')).toBe('卷11');
        expect(juanLabel('001')).toBe('卷1');
        expect(juanLabel('第001.md')).toBe('卷1');
        expect(juanLabel('序')).toBe('序');
    });
    it('每卷各自的标题', () => {
        expect(readerTitle('直齋書錄解題', { kind: 'collated', juan: 'juan/011.json' })).toBe('直齋書錄解題 · 卷11 · 整理本');
        expect(readerTitle('宋史全文', { kind: 'fulltext' })).toBe('宋史全文 · 全文');
    });
});

describe('legacyReaderTarget：旧入口 → 阅读页', () => {
    const t = (path: string) => {
        const u = new URL(`https://x${path}`);
        return legacyReaderTarget(u.pathname, u.searchParams);
    };
    it('/book-index?tab=fulltext&id=…&juan=… 保留卷号', () => {
        expect(t(`/book-index?tab=fulltext&id=${BOOK}&juan=003`)).toBe(`/item/${BOOK}/read?kind=fulltext&juan=003`);
    });
    it('/book-index?id=…&tab=collated（无卷号）', () => {
        expect(t(`/book-index?id=${ZHIZHAI}&tab=collated`)).toBe(`/item/${ZHIZHAI}/read?kind=collated`);
    });
    it('条目页的 fulltext／collated tab', () => {
        expect(t(`/item/${ZHIZHAI}?tab=collated&juan=juan%2F011.json`)).toBe(`/item/${ZHIZHAI}/read?kind=collated&juan=juan%2F011.json`);
        expect(t(`/item/${WORK}?tab=fulltext`)).toBe(`/item/${WORK}/read?kind=fulltext`);
    });
    it('别的 tab 的参数丢掉', () => {
        expect(t(`/book-index?id=${ZHIZHAI}&tab=collated&page=3&mode=graph`)).toBe(`/item/${ZHIZHAI}/read?kind=collated`);
    });
    it.each([
        `/book-index?id=${WORK}`,
        `/book-index?id=${WORK}&tab=lineage`,
        `/book-index?tab=fulltext`,
        `/book-index?id=${BOOK}&tab=collated`, // Book 没有整理本，不跳进 404
        `/book-index?id=${WORK}&tab=collated&redirected_from=1eujfe7s94veo`,
        `/book-index?id=${WORK}&tab=collated&no_redirect=true`,
        `/item/${WORK}`,
        `/item/${ENTITY}?tab=fulltext`,
        `/about?tab=fulltext&id=${WORK}`,
    ])('不是旧阅读入口：%s', (path) => {
        expect(t(path)).toBeNull();
    });
});
