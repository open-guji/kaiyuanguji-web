/**
 * @jest-environment node
 */
import { describe, it, expect, jest } from '@jest/globals';
import { createReadFetcher } from '../read-data';

function make(files: Record<string, unknown>) {
    const urls: string[] = [];
    const fetch = jest.fn(async (url: string) => {
        urls.push(url);
        if (url.includes('latest.json')) return new Response(JSON.stringify({ commitId: 'abc', cacheKey: 'k1' }));
        const rel = url.split('/current/')[1].split('?')[0];
        if (rel in files) return new Response(JSON.stringify(files[rel]));
        return new Response('', { status: rel === 'boom' ? 503 : 404 });
    });
    return { f: createReadFetcher({ base: 'https://d.test', fetch }), urls };
}

describe('createReadFetcher：读 current/read/…?v=<版本键>', () => {
    it('sections／tree／page／period 各取对应文件', async () => {
        const { f, urls } = make({
            'read/sections.json': { counts: { readable: 1 } },
            'read/tree.json': [{ id: 'cshi', label: '史部', count: 1 }],
            'read/cshi/2.json': [{ id: 'w1', title: '書' }],
            'read/period/song/1.json': [{ id: 'w2', title: '宋書' }],
        });
        expect(await f.getSections()).toEqual({ counts: { readable: 1 } });
        expect(await f.getPeriodPage('song', 1)).toEqual([{ id: 'w2', title: '宋書' }]);
        expect(urls.some((u) => u.includes('/current/read/period/song/1.json?v=k1'))).toBe(true);
        expect(await f.getTree()).toEqual([{ id: 'cshi', label: '史部', count: 1 }]);
        expect(await f.getPage('cshi', 2)).toEqual([{ id: 'w1', title: '書' }]);
        expect(urls.some((u) => u.includes('/current/read/cshi/2.json?v=k1'))).toBe(true);
    });
    it('404 ＝ 确定没有，返回 null（这一版数据还没有阅读索引）', async () => {
        const { f } = make({});
        expect(await f.getTree()).toBeNull();
        expect(await f.getPage('cshi', 1)).toBeNull();
        expect(await f.getSections()).toBeNull();
        expect(await f.getPeriodPage('song', 1)).toBeNull();
    });
});
