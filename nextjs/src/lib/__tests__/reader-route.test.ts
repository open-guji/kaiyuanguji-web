/**
 * @jest-environment node
 *
 * overview#307 E 块：阅读页路径式地址（/read/<id>[/<key>][/<章>]）的解析与拼写。
 */
import { describe, it, expect } from '@jest/globals';
import {
    chapterFallbackLabel, hasReaderType, isChapterSegment, isTextKey, parseReaderSegments, readerHref, readerPath, readerTitle, readerVersionName, splitReaderPathname,
} from '../reader-route';

const WORK = 'd59f2htm01du'; // 直齋書錄解題（Work）
const BOOK = '988fbiuha8'; // 御定佩文韻府（Book）
const ENTITY = 'hixhd2h9bk4b'; // 孔子（Entity）

describe('key 与章号的形态', () => {
    it('isTextKey：default 与 [a-z0-9-] 字母开头的非保留字', () => {
        for (const k of ['default', 'collated', 'wikisource', 'wikisource-2', 'open-guji', 'shidian']) expect(isTextKey(k)).toBe(true);
        for (const k of ['manifest', 'fragments', 'sources', '001', '3d', 'Wiki', 'a_b', '', 'a/b', '..']) expect(isTextKey(k)).toBe(false);
    });
    it('章号纯数字、字母开头是 key', () => {
        expect(isChapterSegment('003')).toBe(true);
        expect(isChapterSegment('3')).toBe(true);
        expect(isChapterSegment('wikisource-2')).toBe(false);
        expect(isChapterSegment('3a')).toBe(false);
        expect(isChapterSegment('')).toBe(false);
        expect(isChapterSegment('1234567')).toBe(false);
    });
    it('只有 Work 与 Book 有阅读页', () => {
        expect(hasReaderType(WORK)).toBe(true);
        expect(hasReaderType(BOOK)).toBe(true);
        expect(hasReaderType(ENTITY)).toBe(false);
        expect(hasReaderType('not-an-id')).toBe(false);
    });
});

describe('readerPath／readerHref：主版本不写 key，章号可省', () => {
    it('四种形态', () => {
        expect(readerPath(WORK)).toBe(`/read/${WORK}`);
        expect(readerPath(WORK, { chapter: '003' })).toBe(`/read/${WORK}/003`);
        expect(readerPath(WORK, { key: 'wikisource-2' })).toBe(`/read/${WORK}/wikisource-2`);
        expect(readerPath(WORK, { key: 'wikisource-2', chapter: '003' })).toBe(`/read/${WORK}/wikisource-2/003`);
    });
    it('key 为 default 或空串都当主版本', () => {
        expect(readerPath(WORK, { key: 'default', chapter: '003' })).toBe(`/read/${WORK}/003`);
        expect(readerPath(WORK, { key: '', chapter: '003' })).toBe(`/read/${WORK}/003`);
        expect(readerHref).toBe(readerPath);
    });
});

describe('parseReaderSegments', () => {
    it('没有段＝主版本第一章；一段按形态分章号与 key；两段是 key＋章', () => {
        expect(parseReaderSegments(WORK, [])).toEqual({ sel: {} });
        expect(parseReaderSegments(WORK, undefined)).toEqual({ sel: {} });
        expect(parseReaderSegments(WORK, ['003'])).toEqual({ sel: { chapter: '003' } });
        expect(parseReaderSegments(WORK, ['wikisource'])).toEqual({ sel: { key: 'wikisource' } });
        expect(parseReaderSegments(BOOK, ['wikisource-2', '003'])).toEqual({ sel: { key: 'wikisource-2', chapter: '003' } });
    });
    it('地址里写了 default：308 到不带 default 的形式', () => {
        expect(parseReaderSegments(WORK, ['default'])).toEqual({ redirect: `/read/${WORK}` });
        expect(parseReaderSegments(WORK, ['default', '003'])).toEqual({ redirect: `/read/${WORK}/003` });
    });
    it('形态不对 → null（404）：保留字、大写、三段、章号不是数字、第一段是章号又带第二段', () => {
        for (const segs of [['manifest'], ['Wiki'], ['a', 'b', 'c'], ['wikisource', 'abc'], ['003', '004'], ['fragments', '001'], ['wiki_source']]) {
            expect(parseReaderSegments(WORK, segs)).toBeNull();
        }
    });
    it('条目类型没有阅读页（人物、丛编、乱填的 id）→ null', () => {
        expect(parseReaderSegments(ENTITY, [])).toBeNull();
        expect(parseReaderSegments('xx', [])).toBeNull();
    });
});

describe('splitReaderPathname', () => {
    it('切出 id 与其后的段；末尾斜杠忽略；不是阅读页路径返回 null', () => {
        expect(splitReaderPathname(`/read/${WORK}`)).toEqual({ id: WORK, segs: [] });
        expect(splitReaderPathname(`/read/${WORK}/wikisource/003/`)).toEqual({ id: WORK, segs: ['wikisource', '003'] });
        expect(splitReaderPathname('/read')).toBeNull();
        expect(splitReaderPathname('/item/x')).toBeNull();
    });
});

describe('readerVersionName（页面上的版本名：默认版本不写，非默认只写来源，不出现类别词）', () => {
    it('默认版本不写，不管它的 label 是「整理本」还是「維基文庫」', () => {
        expect(readerVersionName({ key: 'default', label: '整理本' })).toBeUndefined();
        expect(readerVersionName({ key: 'default', label: '維基文庫', source_name: '維基文庫' })).toBeUndefined();
    });
    it('非默认版本写来源名', () => {
        expect(readerVersionName({ key: 'wikisource', label: '維基文庫' })).toBe('維基文庫');
        expect(readerVersionName({ key: 'kanripo', label: ' Kanripo ' })).toBe('Kanripo');
    });
    it('label 若是类别词就改用来源名，都没有就不写', () => {
        expect(readerVersionName({ key: 'x', label: '转录全文', source_name: '維基文庫' })).toBe('維基文庫');
        expect(readerVersionName({ key: 'x', label: '整理本' })).toBeUndefined();
        expect(readerVersionName({ key: 'x', label: '全文', source_name: '全文' })).toBeUndefined();
        expect(readerVersionName(undefined)).toBeUndefined();
    });
});

describe('readerTitle', () => {
    it('书名 · 章名 · 版本名；没有章名用「卷N」；没有章号也不写', () => {
        expect(readerTitle('直齋書錄解題', '003', '史錄')).toBe('直齋書錄解題 · 史錄');
        expect(readerTitle('紅樓夢', '003', undefined, '維基文庫')).toBe('紅樓夢 · 卷3 · 維基文庫');
        expect(readerTitle('紅樓夢', undefined, undefined, '維基文庫')).toBe('紅樓夢 · 維基文庫');
        expect(readerTitle('紅樓夢', '003', ' 第三回 ')).toBe('紅樓夢 · 第三回');
        expect(chapterFallbackLabel('011')).toBe('卷11');
        expect(chapterFallbackLabel('序')).toBe('序');
    });
});
