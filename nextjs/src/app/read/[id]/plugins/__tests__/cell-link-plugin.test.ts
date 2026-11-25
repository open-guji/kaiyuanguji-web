/**
 * 深链 ?u=（字格永久编号，guji-char v0.6）与 ?cell=：阅读器插件查本章 char 的 u，交给宿主当锚点。
 */
const loadReaderFiles = jest.fn();
jest.mock('book-index-ui', () => ({ loadReaderFiles: (...a: unknown[]) => loadReaderFiles(...a) }));

import { cellLinkPlugin } from '../cell-link-plugin';

const char = { pages: [{ page: 3, columns: [{ col: 4, cells: [{ a: '3:4:5', u: 100 }, { a: '3:4:6a', u: 101 }] }] }] };
const ctx = (chapterKey = '031') => ({ entryId: '96mid1ogzk', versionKey: 'default', chapterKey, chapter: { file: chapterKey }, viewport: 'wide', transport: {} }) as never;

beforeEach(() => loadReaderFiles.mockReset());

describe('cellLinkPlugin', () => {
    it('?u= 查到本章格位就交给宿主；同章同请求只给一次', async () => {
        loadReaderFiles.mockResolvedValue({ char });
        const onResolve = jest.fn();
        const p = cellLinkPlugin({ onResolve, getSearch: () => '?u=101' });
        await p.onChapter!(ctx());
        expect(onResolve).toHaveBeenCalledWith('3:4:6a');
        await p.onChapter!(ctx());
        expect(onResolve).toHaveBeenCalledTimes(1);
    });
    it('?u= 范围', async () => {
        loadReaderFiles.mockResolvedValue({ char });
        const onResolve = jest.fn();
        await cellLinkPlugin({ onResolve, getSearch: () => '?u=100~101' }).onChapter!(ctx());
        expect(onResolve).toHaveBeenCalledWith('3:4:5~3:4:6a');
    });
    it('u 查不到、char 没有 u、本章没有对读：不给（#格位 兜底）', async () => {
        const onResolve = jest.fn();
        loadReaderFiles.mockResolvedValue({ char });
        await cellLinkPlugin({ onResolve, getSearch: () => '?u=999' }).onChapter!(ctx());
        loadReaderFiles.mockResolvedValue({ char: { pages: [{ page: 3, columns: [{ col: 4, cells: [{ a: '3:4:5' }] }] }] } });
        await cellLinkPlugin({ onResolve, getSearch: () => '?u=100' }).onChapter!(ctx());
        loadReaderFiles.mockResolvedValue(null);
        await cellLinkPlugin({ onResolve, getSearch: () => '?u=100' }).onChapter!(ctx());
        expect(onResolve).not.toHaveBeenCalled();
    });
    it('?cell= 直接给，不取文件；没有请求就什么都不做', async () => {
        const onResolve = jest.fn();
        await cellLinkPlugin({ onResolve, getSearch: () => '?cell=3:4:5' }).onChapter!(ctx());
        expect(onResolve).toHaveBeenCalledWith('3:4:5');
        await cellLinkPlugin({ onResolve, getSearch: () => '?proof=1' }).onChapter!(ctx());
        expect(onResolve).toHaveBeenCalledTimes(1);
        expect(loadReaderFiles).not.toHaveBeenCalled();
    });
});
