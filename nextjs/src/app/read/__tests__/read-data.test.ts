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
    it('featured／tree／page 各取对应文件', async () => {
        const { f, urls } = make({
            'read/featured.json': { collated: [], books: [] },
            'read/tree.json': [{ id: 'cshi', label: '史部', count: 1 }],
            'read/cshi/2.json': [{ id: 'w1', title: '書' }],
        });
        expect(await f.getFeatured()).toEqual({ collated: [], books: [] });
        expect(await f.getTree()).toEqual([{ id: 'cshi', label: '史部', count: 1 }]);
        expect(await f.getPage('cshi', 2)).toEqual([{ id: 'w1', title: '書' }]);
        expect(urls.some((u) => u.includes('/current/read/cshi/2.json?v=k1'))).toBe(true);
    });
    it('404 ＝ 确定没有，返回 null（这一版数据还没有阅读索引）', async () => {
        const { f } = make({});
        expect(await f.getTree()).toBeNull();
        expect(await f.getPage('cshi', 1)).toBeNull();
    });
});
