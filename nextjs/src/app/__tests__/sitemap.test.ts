/**
 * @jest-environment node
 *
 * FX1：全栈构建的 /sitemap.xml 只列静态页（条目由 /sitemaps/* 分片列）；静态导出照旧带旧详情地址。
 */
import { describe, it, expect, jest, afterEach } from '@jest/globals';

const mockGetAllEntries = jest.fn(async () => [{ id: 'd59f20aowb9c' }, { id: '1evgpgqsis9hc' }]);

jest.mock('book-index-ui/storage', () => ({
    GithubStorage: jest.fn().mockImplementation(() => ({ getAllEntries: mockGetAllEntries })),
}));

const ORIGINAL = process.env.KYG_RENDER_MODE;

afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.KYG_RENDER_MODE;
    else process.env.KYG_RENDER_MODE = ORIGINAL;
    mockGetAllEntries.mockClear();
});

async function urls(): Promise<string[]> {
    const { default: sitemap } = await import('../sitemap');
    return (await sitemap()).map((r) => r.url);
}

describe('app/sitemap.ts', () => {
    it('全栈构建：只列静态页，不带 /book-index?id=，也不去取条目列表', async () => {
        process.env.KYG_RENDER_MODE = 'fullstack';
        const u = await urls();
        expect(u.length).toBeGreaterThan(0);
        expect(u.filter((x) => x.includes('/book-index?id='))).toEqual([]);
        expect(u.some((x) => x.endsWith('/about'))).toBe(true);
        // /contact 已并进关于页、308 到 /about#联系（9-30 反馈，overview#322），不再列
        expect(u.some((x) => x.endsWith('/contact'))).toBe(false);
        expect(u.some((x) => x.endsWith('/read'))).toBe(true);
        expect(u.some((x) => x.endsWith('/catalog'))).toBe(true);
        expect(u.filter((x) => x.endsWith('/read') || x.endsWith('/catalog'))).toHaveLength(2); // 不重复
        expect(mockGetAllEntries).not.toHaveBeenCalled();
    });

    it('静态导出（不设开关）：行为不变，仍列旧详情地址', async () => {
        delete process.env.KYG_RENDER_MODE;
        const u = await urls();
        expect(u.filter((x) => x.includes('/book-index?id='))).toHaveLength(2);
        expect(u.some((x) => x.endsWith('/book-index?id=d59f20aowb9c'))).toBe(true);
        // /read 只在全栈构建里有，静态导出的 sitemap 不列
        expect(u.some((x) => x.endsWith('/read'))).toBe(false);
        expect(u.some((x) => x.endsWith('/catalog'))).toBe(false);
    });
});
