/**
 * @jest-environment node
 *
 * WEB2（overview#249 Q2）：阅读页首屏数据——服务端取清单、目录、首卷正文，交给 seedTransport。
 */
import { describe, it, expect, jest } from '@jest/globals';
import { preloadReader, SEED_TEXT_MAX } from '../preload';
import { seedCallKey, seedTransport, firstChapterFile, collatedJuanFiles } from '../reader-seed';
import { fullTextShardOf } from '@/lib/server/reader-check';
import type { IndexStorage } from 'book-index-ui/storage';

const SONGSHI = 'd59f2gonq7sy'; // Work
const BOOK = '988fbiuha8';
const ZHIZHAI = 'd59f2htm01du';

const FT_INDEX = { chapters: [{ n: 1, title: '卷一', file: '001.md' }, { n: 2, title: '卷二', file: '002.md' }] };

function store(json: Record<string, unknown>, text: Record<string, string> = {}) {
    const getJson = jest.fn(async (rel: string) => (rel in json ? json[rel] : null)) as unknown as <T>(rel: string) => Promise<T | null>;
    const getText = jest.fn(async (rel: string, max?: number) => {
        const t = text[rel];
        if (t === undefined) return null;
        return max !== undefined && t.length > max ? null : t;
    });
    return { getJson, getText };
}

describe('preloadReader', () => {
    const shard = `index/full_text/${fullTextShardOf(SONGSHI)}.json`;
    const list = [
        { key: 'wikisource-01', owner_type: 'Work', primary: true },
        { key: 'other', owner_type: 'Work' },
        { key: 'bk', owner_type: 'Book' },
    ];

    it('Work 全文没带 key：清单（滤掉 Book）、首选那份的目录、第一章正文', async () => {
        const { getJson, getText } = store(
            { [shard]: { [SONGSHI]: list }, [`items/${SONGSHI}/full_text/wikisource-01/index.json`]: FT_INDEX },
            { [`items/${SONGSHI}/full_text/wikisource-01/001.txt`]: '太祖啟運立極' },
        );
        const seed = await preloadReader(SONGSHI, { kind: 'fulltext' }, true, getJson, getText);
        expect(seed.workTexts!.map((v) => v.key)).toEqual(['wikisource-01', 'other']);
        expect(seed.key).toBe('wikisource-01');
        expect(seed.fullTextIndex).toBe(FT_INDEX);
        expect(seed.calls![seedCallKey('getWorkFullTextList', SONGSHI)]).toEqual(seed.workTexts);
        expect(seed.calls![seedCallKey('getWorkFullTextChapter', SONGSHI, 'wikisource-01', '001.md')]).toBe('太祖啟運立極');
    });

    it('Work 全文带 key 与卷号：取那一份那一章', async () => {
        const { getJson, getText } = store(
            { [shard]: { [SONGSHI]: list }, [`items/${SONGSHI}/full_text/other/index.json`]: FT_INDEX },
            { [`items/${SONGSHI}/full_text/other/002.txt`]: '卷二正文' },
        );
        const seed = await preloadReader(SONGSHI, { kind: 'fulltext', key: 'other', juan: '002' }, true, getJson, getText);
        expect(seed.key).toBe('other');
        expect(seed.calls![seedCallKey('getWorkFullTextChapter', SONGSHI, 'other', '002.md')]).toBe('卷二正文');
    });

    it('Book 全文：目录与首章，卷号对不上回落第一章', async () => {
        const { getJson, getText } = store(
            { [`items/${BOOK}/full_text/index.json`]: FT_INDEX },
            { [`items/${BOOK}/full_text/001.txt`]: '正文' },
        );
        const seed = await preloadReader(BOOK, { kind: 'fulltext', juan: '999' }, false, getJson, getText);
        expect(seed.workTexts).toBeUndefined();
        expect(seed.fullTextIndex).toBe(FT_INDEX);
        expect(seed.calls![seedCallKey('getBookFullTextChapter', BOOK, '001.md')]).toBe('正文');
    });

    it('整理本：卷目录、首卷数据与正文一起给', async () => {
        const index = { juan_files: ['juan/001.json', 'juan/002.json'] };
        const { getJson, getText } = store(
            { [`items/${ZHIZHAI}/collated_edition/index.json`]: index, [`items/${ZHIZHAI}/collated_edition/juan/001.json`]: { title: '卷一', sections: [] } },
            { [`items/${ZHIZHAI}/collated_edition/text/juan/001.txt`]: '易類' },
        );
        const seed = await preloadReader(ZHIZHAI, { kind: 'collated' }, true, getJson, getText);
        expect(seed.collatedIndex).toBe(index);
        expect(seed.calls![seedCallKey('getCollatedJuan', ZHIZHAI, 'juan/001.json')]).toEqual({ title: '卷一', sections: [] });
        expect(seed.calls![seedCallKey('getCollatedJuanText', ZHIZHAI, 'juan/001.json')]).toBe('易類');
    });

    it('整理本卷正文取不到：卷数据也不给（不让组件拿半份数据渲染）', async () => {
        const { getJson, getText } = store({
            [`items/${ZHIZHAI}/collated_edition/index.json`]: { juan_files: ['juan/001.json'] },
            [`items/${ZHIZHAI}/collated_edition/juan/001.json`]: { title: '卷一', sections: [] },
        });
        const seed = await preloadReader(ZHIZHAI, { kind: 'collated' }, true, getJson, getText);
        expect(seed.collatedIndex).toBeTruthy();
        expect(seed.calls).toEqual({});
    });

    it('正文过大：不随页面带，目录照给', async () => {
        const { getJson, getText } = store(
            { [`items/${BOOK}/full_text/index.json`]: FT_INDEX },
            { [`items/${BOOK}/full_text/001.txt`]: 'x'.repeat(SEED_TEXT_MAX + 1) },
        );
        const seed = await preloadReader(BOOK, { kind: 'fulltext' }, false, getJson, getText);
        expect(seed.fullTextIndex).toBe(FT_INDEX);
        expect(seed.calls).toEqual({});
    });

    it('取数出错：少放一项，不抛错', async () => {
        const getJson = (async () => { throw new Error('HTTP 502'); }) as unknown as <T>(rel: string) => Promise<T | null>;
        const getText = async () => null;
        await expect(preloadReader(SONGSHI, { kind: 'fulltext' }, true, getJson, getText)).resolves.toEqual({});
        await expect(preloadReader(ZHIZHAI, { kind: 'collated' }, true, getJson, getText)).resolves.toEqual({});
    });
});

describe('seedTransport', () => {
    it('命中种子直接返回、不调底层；没命中或种子是 null 照常转给底层', async () => {
        const base = {
            getBookFullTextChapter: jest.fn(async (_id: string, file: string) => `net:${file}`),
            getWorkFullTextList: jest.fn(async () => []),
        } as unknown as IndexStorage;
        const t = seedTransport(base, {
            [seedCallKey('getBookFullTextChapter', BOOK, '001.md')]: '种子',
            [seedCallKey('getBookFullTextChapter', BOOK, '003.md')]: null,
        });
        await expect(t.getBookFullTextChapter!(BOOK, '001.md')).resolves.toBe('种子');
        expect(base.getBookFullTextChapter).not.toHaveBeenCalled();
        await expect(t.getBookFullTextChapter!(BOOK, '002.md')).resolves.toBe('net:002.md');
        await expect(t.getBookFullTextChapter!(BOOK, '003.md')).resolves.toBe('net:003.md');
        expect(base.getBookFullTextChapter).toHaveBeenCalledTimes(2);
    });

    it('没有种子：原样返回同一个 transport', () => {
        const base = {} as IndexStorage;
        expect(seedTransport(base, undefined)).toBe(base);
        expect(seedTransport(base, {})).toBe(base);
    });
});

describe('firstChapterFile / collatedJuanFiles', () => {
    it('卷号带不带 .md 都认；空目录返回 null', () => {
        expect(firstChapterFile(FT_INDEX as never, '002.md')).toBe('002.md');
        expect(firstChapterFile(FT_INDEX as never, undefined)).toBe('001.md');
        expect(firstChapterFile({ chapters: [] } as never, '001')).toBeNull();
    });
    it('juan_files 优先，退回 files[].filename', () => {
        expect(collatedJuanFiles({ juan_files: ['a.json'] } as never)).toEqual(['a.json']);
        expect(collatedJuanFiles({ files: [{ filename: 'b.json' }] } as never)).toEqual(['b.json']);
        expect(collatedJuanFiles({} as never)).toEqual([]);
    });
});
