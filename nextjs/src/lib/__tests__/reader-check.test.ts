/**
 * @jest-environment node
 *
 * N5b：阅读页服务端校验 kind／key／juan（web#99 审查：乱填卷号不能 200 出软 404）。
 */
import { describe, it, expect, jest } from '@jest/globals';
import { checkReader, checkReaderQuery, fullTextShardOf, type GetCurrentJson } from '../server/reader-check';

const ZHIZHAI = 'd59f2htm01du'; // Work，有整理本
const SONGSHI = 'd59f2gonq7sy'; // Work，有 Work 全文 wikisource-01
const BOOK = '988fbiuha8';

const FILES: Record<string, unknown> = {
    [`items/${ZHIZHAI}/collated_edition/index.json`]: { juan_files: ['juan/001.json', 'juan/011.json'] },
    [`index/full_text/${fullTextShardOf(SONGSHI)}.json`]: {
        [SONGSHI]: [
            { key: 'from-book', owner_type: 'Book' },
            { key: 'wikisource-01', owner_type: 'Work', primary: true },
        ],
    },
    [`items/${SONGSHI}/full_text/wikisource-01/index.json`]: { chapters: [{ file: '001.md' }, { file: '002.md' }] },
    [`items/${BOOK}/full_text/index.json`]: { chapters: [{ file: '第001.md' }] },
};

const get: GetCurrentJson = async <T,>(rel: string) => (FILES[rel] ?? null) as T | null;

describe('checkReaderQuery', () => {
    it('宋史的全文分片与 book-index-ui 的 shardOf 一致（e）', () => {
        expect(fullTextShardOf(SONGSHI)).toBe('e');
    });

    it.each<[string, string, Parameters<typeof checkReaderQuery>[1], boolean]>([
        ['整理本、无卷号', ZHIZHAI, { kind: 'collated' }, true],
        ['整理本、卷号在 juan_files 里（旧的卷文件名）', ZHIZHAI, { kind: 'collated', juan: 'juan/011.json' }, true],
        ['整理本、短形式卷号', ZHIZHAI, { kind: 'collated', juan: '011' }, true],
        ['Work 全文、无 key 取首选（跳过 Book 层那份）', SONGSHI, { kind: 'fulltext', juan: '002' }, true],
        ['Work 全文、key 对', SONGSHI, { kind: 'fulltext', key: 'wikisource-01', juan: '001.md' }, true],
        ['Book 全文、章节 stem', BOOK, { kind: 'fulltext', juan: '第001' }, false],
    ])('found：%s', async (_n, id, q, isWork) => {
        expect(await checkReaderQuery(id, q, isWork, get)).toBe('found');
    });

    it.each<[string, string, Parameters<typeof checkReaderQuery>[1], boolean]>([
        ['乱填的整理本卷号', ZHIZHAI, { kind: 'collated', juan: 'juan/999.json' }, true],
        ['乱填的整理本短卷号', ZHIZHAI, { kind: 'collated', juan: '999' }, true],
        ['整理本卷号带扩展名却不是卷文件名', ZHIZHAI, { kind: 'collated', juan: '011.json' }, true],
        ['没有整理本的 Work', SONGSHI, { kind: 'collated' }, true],
        ['乱填的全文卷号', SONGSHI, { kind: 'fulltext', juan: '999' }, true],
        ['不存在的 key', SONGSHI, { kind: 'fulltext', key: 'nope' }, true],
        ['key 带路径穿越', SONGSHI, { kind: 'fulltext', key: '../x' }, true],
        ['没有 Work 全文的 Work', ZHIZHAI, { kind: 'fulltext' }, true],
        ['没有全文的 Book', '988fbiuhaz', { kind: 'fulltext' }, false],
        ['Book 全文乱填卷号', BOOK, { kind: 'fulltext', juan: '002' }, false],
    ])('missing：%s', async (_n, id, q, isWork) => {
        expect(await checkReaderQuery(id, q, isWork, get)).toBe('missing');
    });

    it('查不了（网络错）→ unknown，不当成 404', async () => {
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        const broken: GetCurrentJson = async () => { throw new Error('HTTP 502'); };
        expect(await checkReaderQuery(ZHIZHAI, { kind: 'collated', juan: 'juan/011.json' }, true, broken)).toBe('unknown');
    });
});

describe('checkReader：带回章名', () => {
    const withTitles: GetCurrentJson = async <T,>(rel: string) => ({
        ...FILES,
        [`items/${BOOK}/full_text/index.json`]: { chapters: [{ file: '003.md', title: ' 第三回 ' }, { file: '004.md', title: '' }, { file: '005.md' }] },
        [`items/${SONGSHI}/full_text/wikisource-01/index.json`]: { chapters: [{ file: '001.md', title: '卷一' }] },
    } as Record<string, unknown>)[rel] as T | null ?? null;

    it('Book、Work 全文取目录里的章名（去空白）；没有章名、没带卷号、整理本都是 undefined', async () => {
        expect(await checkReader(BOOK, { kind: 'fulltext', juan: '003' }, false, withTitles)).toEqual({ status: 'found', chapterTitle: '第三回' });
        expect(await checkReader(BOOK, { kind: 'fulltext', juan: '003.md' }, false, withTitles)).toEqual({ status: 'found', chapterTitle: '第三回' });
        expect(await checkReader(BOOK, { kind: 'fulltext', juan: '004' }, false, withTitles)).toEqual({ status: 'found', chapterTitle: undefined });
        expect(await checkReader(BOOK, { kind: 'fulltext', juan: '005' }, false, withTitles)).toEqual({ status: 'found', chapterTitle: undefined });
        expect(await checkReader(BOOK, { kind: 'fulltext' }, false, withTitles)).toEqual({ status: 'found', chapterTitle: undefined });
        expect(await checkReader(SONGSHI, { kind: 'fulltext', key: 'wikisource-01', juan: '001' }, true, withTitles)).toEqual({ status: 'found', chapterTitle: '卷一' });
        expect(await checkReader(ZHIZHAI, { kind: 'collated', juan: '011' }, true, withTitles)).toEqual({ status: 'found' });
    });
    it('查不到就 missing，没有章名', async () => {
        expect(await checkReader(BOOK, { kind: 'fulltext', juan: '999' }, false, withTitles)).toEqual({ status: 'missing' });
    });
});

describe('checkReaderQuery：全文目录 chapters 为空算没有（与阅读索引判据一致，overview#306）', () => {
    const EMPTY_BOOK = '988fbiuha9';
    const EMPTY_WORK = 'd59f2gonq7sz';
    const files: Record<string, unknown> = {
        [`items/${EMPTY_BOOK}/full_text/index.json`]: { chapters: [] },
        [`index/full_text/${fullTextShardOf(EMPTY_WORK)}.json`]: { [EMPTY_WORK]: [{ key: 'k1', owner_type: 'Work', primary: true }] },
        [`items/${EMPTY_WORK}/full_text/k1/index.json`]: { chapters: [] },
    };
    const g: GetCurrentJson = async <T,>(rel: string) => (files[rel] ?? null) as T | null;

    it('Book：full_text/index.json 存在但 chapters 为空 → missing', async () => {
        expect(await checkReaderQuery(EMPTY_BOOK, { kind: 'fulltext' }, false, g)).toBe('missing');
    });
    it('Work：带 key 取目录，chapters 为空 → missing', async () => {
        expect(await checkReaderQuery(EMPTY_WORK, { kind: 'fulltext', key: 'k1' }, true, g)).toBe('missing');
    });
});

