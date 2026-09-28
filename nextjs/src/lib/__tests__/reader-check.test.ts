/**
 * @jest-environment node
 *
 * N5b：阅读页服务端校验 kind／key／juan（web#99 审查：乱填卷号不能 200 出软 404）。
 */
import { describe, it, expect, jest } from '@jest/globals';
import { checkReaderQuery, fullTextShardOf, type GetCurrentJson } from '../server/reader-check';

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
        ['整理本、卷号在 juan_files 里', ZHIZHAI, { kind: 'collated', juan: 'juan/011.json' }, true],
        ['Work 全文、无 key 取首选（跳过 Book 层那份）', SONGSHI, { kind: 'fulltext', juan: '002' }, true],
        ['Work 全文、key 对', SONGSHI, { kind: 'fulltext', key: 'wikisource-01', juan: '001.md' }, true],
        ['Book 全文、章节 stem', BOOK, { kind: 'fulltext', juan: '第001' }, false],
    ])('found：%s', async (_n, id, q, isWork) => {
        expect(await checkReaderQuery(id, q, isWork, get)).toBe('found');
    });

    it.each<[string, string, Parameters<typeof checkReaderQuery>[1], boolean]>([
        ['乱填的整理本卷号', ZHIZHAI, { kind: 'collated', juan: 'juan/999.json' }, true],
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
