/**
 * duidu-data.ts：对读数据文件的取数来源（overview#421）。
 * storage 上有 getTextFile（cos 数据源）就走它，不拼同域 /data 路径；没有（bundle／本地）退回 /data/items/...。
 */
import { jest } from '@jest/globals';
import { loadDuiduFiles } from '../duidu-data';

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
