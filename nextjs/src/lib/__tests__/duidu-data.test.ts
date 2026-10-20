/**
 * duidu-data.ts：对读数据文件的取数来源（overview#421）。
 * storage 上有 getTextFile（cos 数据源）就走它，不拼同域 /data 路径；没有（bundle／本地）退回 /data/items/...。
 */
import { jest } from '@jest/globals';
import { loadDuiduFiles, volumeFromChar } from '../duidu-data';

const chapter = { file: '003', char_file: '003.char.json', cord_file: '003.cord.json', punct_file: '003.punct.json', entity_file: '003.entity.json' };

describe('loadDuiduFiles', () => {
    let originalFetch: typeof fetch;
    beforeEach(() => { originalFetch = global.fetch; });
    afterEach(() => { global.fetch = originalFetch; });

    it('storage 有 getTextFile：四个文件都经它取，不发同域请求', async () => {
        const fetchMock = jest.fn();
        global.fetch = fetchMock as unknown as typeof fetch;
        const getTextFile = jest.fn(async (_id: string, _key: string, file: string) => ({ file }));
        const r = await loadDuiduFiles('book-s1', { versionKey: 'original', chapter }, '003', { getTextFile });
        expect(r).toEqual({ char: { file: '003.char.json' }, cord: { file: '003.cord.json' }, punct: { file: '003.punct.json' }, entity: { file: '003.entity.json' }, norm: null });
        expect(getTextFile.mock.calls.map(c => c.join('/')).sort()).toEqual([
            'book-s1/original/003.char.json', 'book-s1/original/003.cord.json', 'book-s1/original/003.entity.json', 'book-s1/original/003.punct.json',
        ]);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('cord: false（窄屏，GUJI-700）：不取 cord，cord 为 null 并标 cordSkipped；与取 cord 的结果分开缓存', async () => {
        const getTextFile = jest.fn(async (_id: string, _key: string, file: string) => ({ file }));
        const r = await loadDuiduFiles('book-cv1', { versionKey: 'original', chapter }, '003', { getTextFile }, { cord: false });
        expect(r).toMatchObject({ char: { file: '003.char.json' }, cord: null, cordSkipped: true });
        expect(getTextFile.mock.calls.map(c => c[2])).not.toContain('003.cord.json');
        const wide = await loadDuiduFiles('book-cv1', { versionKey: 'original', chapter }, '003', { getTextFile });
        expect(wide).toMatchObject({ cord: { file: '003.cord.json' } });
        expect(wide?.cordSkipped).toBeUndefined();
    });

    it('有阅读器瘦身副本（reader_cord_file／reader_punct_file，GUJI-700）：先取副本，不取原文件', async () => {
        const getTextFile = jest.fn(async (_id: string, _key: string, file: string) => ({ file }));
        const ch = { ...chapter, reader_cord_file: '003.cord.reader.json', reader_punct_file: '003.punct.reader.json' };
        const r = await loadDuiduFiles('book-rf1', { versionKey: 'original', chapter: ch }, '003', { getTextFile });
        expect(r).toMatchObject({ cord: { file: '003.cord.reader.json' }, punct: { file: '003.punct.reader.json' } });
        expect(getTextFile.mock.calls.map(c => c[2]).sort()).toEqual(['003.char.json', '003.cord.reader.json', '003.entity.json', '003.punct.reader.json']);
    });

    it('char／entity 也有副本（reader_char_file／reader_entity_file，P2-A）：先取副本，取不到回落原文件', async () => {
        const getTextFile = jest.fn(async (_id: string, _key: string, file: string) => ({ file }));
        const ch = { ...chapter, reader_char_file: '003.char.reader.json', reader_entity_file: '003.entity.reader.json' };
        const r = await loadDuiduFiles('book-rf4', { versionKey: 'original', chapter: ch }, '003', { getTextFile });
        expect(r).toMatchObject({ char: { file: '003.char.reader.json' }, entity: { file: '003.entity.reader.json' } });
        expect(getTextFile.mock.calls.map(c => c[2])).not.toContain('003.char.json');
        const miss = jest.fn(async (_id: string, _key: string, file: string) => (file.includes('.reader.') ? null : { file }));
        const r2 = await loadDuiduFiles('book-rf5', { versionKey: 'original', chapter: ch }, '003', { getTextFile: miss });
        expect(r2).toMatchObject({ char: { file: '003.char.json' }, entity: { file: '003.entity.json' } });
    });

    it('副本取不到：回落原文件；窄屏不取 cord 时副本也不取；带路径的副本名不认', async () => {
        const getTextFile = jest.fn(async (_id: string, _key: string, file: string) => (file.includes('.reader.') ? null : { file }));
        const ch = { ...chapter, reader_cord_file: '003.cord.reader.json', reader_punct_file: '../x.json' };
        const r = await loadDuiduFiles('book-rf2', { versionKey: 'original', chapter: ch }, '003', { getTextFile });
        expect(r).toMatchObject({ cord: { file: '003.cord.json' }, punct: { file: '003.punct.json' } });
        expect(getTextFile.mock.calls.map(c => c[2])).not.toContain('../x.json');
        getTextFile.mockClear();
        await loadDuiduFiles('book-rf3', { versionKey: 'original', chapter: ch }, '003', { getTextFile }, { cord: false });
        expect(getTextFile.mock.calls.map(c => c[2]).filter(f => f.includes('cord'))).toEqual([]);
    });

    it('volumeFromChar：book_id＋volume → IIIF 册号（两位补零）；字段不合规返回 null', () => {
        expect(volumeFromChar({ book_id: '96mid1ogzk', volume: 2 })).toEqual({ bookId: '96mid1ogzk', vol: '02' });
        expect(volumeFromChar({ book_id: '96mid1ogzk', volume: 12 })).toEqual({ bookId: '96mid1ogzk', vol: '12' });
        expect(volumeFromChar({ book_id: '../x', volume: 2 })).toBeNull();
        expect(volumeFromChar({ book_id: '96mid1ogzk' })).toBeNull();
        expect(volumeFromChar(null)).toBeNull();
    });

    it('storage 没有 getTextFile（bundle／本地）：读同域 /data/items/<id>/<版本>/<文件>', async () => {
        const urls: string[] = [];
        global.fetch = jest.fn(async (url: string) => {
            urls.push(url);
            return { ok: true, json: async () => ({ url }) } as Response;
        }) as unknown as typeof fetch;
        const r = await loadDuiduFiles('book-s2', { versionKey: 'original', chapter }, '003', {});
        expect(r?.char).toEqual({ url: '/data/items/book-s2/original/003.char.json' });
        expect(urls.sort()).toEqual([
            '/data/items/book-s2/original/003.char.json', '/data/items/book-s2/original/003.cord.json',
            '/data/items/book-s2/original/003.entity.json', '/data/items/book-s2/original/003.punct.json',
        ]);
    });

    it('char 或（已声明的）cord 取不到 → null（不缓存失败）', async () => {
        const getTextFile = jest.fn(async (_i: string, _k: string, file: string) => (file.includes('cord') ? null : { file }));
        expect(await loadDuiduFiles('book-s3', { versionKey: 'original', chapter }, '003', { getTextFile })).toBeNull();
        const calls = getTextFile.mock.calls.length;
        expect(await loadDuiduFiles('book-s3', { versionKey: 'original', chapter }, '003', { getTextFile })).toBeNull();
        expect(getTextFile.mock.calls.length).toBeGreaterThan(calls); // 失败没被缓存，第二次又去取了
        const charNull = jest.fn(async (_i: string, _k: string, file: string) => (file.includes('char') ? null : { file }));
        expect(await loadDuiduFiles('book-s5', { versionKey: 'original', chapter }, '003', { getTextFile: charNull })).toBeNull();
    });

    it('只有 char_file（没有 cord_file）：只加载 char（及声明了的 punct／entity），cord 为 null，不抛错', async () => {
        const getTextFile = jest.fn(async (_i: string, _k: string, file: string) => ({ file }));
        const charOnly = { file: '003', char_file: '003.char.json', punct_file: '003.punct.json' };
        const r = await loadDuiduFiles('book-s6', { versionKey: 'original', chapter: charOnly }, '003', { getTextFile });
        expect(r).toEqual({ char: { file: '003.char.json' }, cord: null, punct: { file: '003.punct.json' }, entity: null, norm: null });
        expect(getTextFile.mock.calls.map(c => c.join('/')).sort()).toEqual(['book-s6/original/003.char.json', 'book-s6/original/003.punct.json']);
    });

    it('char_file＋cord_file 都有：两者都加载，cord 不为 null', async () => {
        const getTextFile = jest.fn(async (_i: string, _k: string, file: string) => ({ file }));
        const both = { file: '003', char_file: '003.char.json', cord_file: '003.cord.json' };
        const r = await loadDuiduFiles('book-s7', { versionKey: 'original', chapter: both }, '003', { getTextFile });
        expect(r).toEqual({ char: { file: '003.char.json' }, cord: { file: '003.cord.json' }, punct: null, entity: null, norm: null });
    });

    it('声明了 norm_file：norm 为取回的对象；未声明为 null', async () => {
        const getTextFile = jest.fn(async (_i: string, _k: string, file: string) => ({ file }));
        const withNorm = { file: '003', char_file: '003.char.json', norm_file: '003.norm.json' };
        const r = await loadDuiduFiles('book-n1', { versionKey: 'original', chapter: withNorm }, '003', { getTextFile });
        expect(r).toEqual({ char: { file: '003.char.json' }, cord: null, punct: null, entity: null, norm: { file: '003.norm.json' } });
        const r2 = await loadDuiduFiles('book-n2', { versionKey: 'original', chapter }, '003', { getTextFile });
        expect(r2?.norm).toBeNull();
    });

    it('norm_file 取不到：norm 为 null，整章不返回 null（norm 是可选层）', async () => {
        const getTextFile = jest.fn(async (_i: string, _k: string, file: string) => (file.includes('norm') ? null : { file }));
        const withNorm = { file: '003', char_file: '003.char.json', norm_file: '003.norm.json' };
        const r = await loadDuiduFiles('book-n3', { versionKey: 'original', chapter: withNorm }, '003', { getTextFile });
        expect(r).toEqual({ char: { file: '003.char.json' }, cord: null, punct: null, entity: null, norm: null });
    });

    it('norm_file 暂时取不到：不缓存，下次恢复后能取到（且留日志）', async () => {
        let normOk = false;
        const getTextFile = jest.fn(async (_i: string, _k: string, file: string) => (file.includes('norm') && !normOk ? null : { file }));
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const ch = { file: '003', char_file: '003.char.json', norm_file: '003.norm.json' };
        const r1 = await loadDuiduFiles('book-s-retry', { versionKey: 'original', chapter: ch }, '003', { getTextFile });
        await Promise.resolve();
        expect(r1?.norm).toBeNull();
        expect(warn).toHaveBeenCalledTimes(1);
        normOk = true;
        const r2 = await loadDuiduFiles('book-s-retry', { versionKey: 'original', chapter: ch }, '003', { getTextFile });
        expect(r2?.norm).toEqual({ file: '003.norm.json' });
        warn.mockRestore();
    });

    it('norm_file 写成带路径被 fileField 拒绝：norm 为 null，不发该请求', async () => {
        const getTextFile = jest.fn(async (_i: string, _k: string, file: string) => ({ file }));
        const bad = { file: '003', char_file: '003.char.json', norm_file: '../x.json' };
        const r = await loadDuiduFiles('book-n4', { versionKey: 'original', chapter: bad }, '003', { getTextFile });
        expect(r?.norm).toBeNull();
        expect(getTextFile.mock.calls.map(c => c.join('/'))).toEqual(['book-n4/original/003.char.json']);
    });

    it('char_file 与 cord_file 都没有：返回 null，不发请求', async () => {
        const none = jest.fn();
        expect(await loadDuiduFiles('book-s4', { versionKey: 'original', chapter: { file: '003' } }, '003', { getTextFile: none })).toBeNull();
        expect(await loadDuiduFiles('book-s4', { versionKey: 'original', chapter: { file: '003', cord_file: '003.cord.json' } }, '003', { getTextFile: none })).toBeNull();
        expect(none).not.toHaveBeenCalled();
    });
});
