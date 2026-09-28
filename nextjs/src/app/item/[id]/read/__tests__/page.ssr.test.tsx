/**
 * @jest-environment node
 *
 * N5b：阅读页服务端——卷号／key 查不到真 404，查不了时 canonical 回落到不带卷号的地址（web#99 审查）。
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mockGetCurrentJson = jest.fn<(rel: string) => Promise<unknown>>();
jest.mock('@/lib/server/item-data', () => ({
    getItemServer: async (id: string) => ({ entry: { id, type: 'work', title: '直齋書錄解題' }, source: 'h1', version: 'h1:r' }),
    getPromotionServer: async () => ({ status: 'absent' }),
    getCurrentJsonServer: (rel: string) => mockGetCurrentJson(rel),
}));
jest.mock('next/navigation', () => ({
    notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
    redirect: (to: string) => { throw new Error(`REDIRECT ${to}`); },
    permanentRedirect: (to: string) => { throw new Error(`REDIRECT ${to}`); },
}));
jest.mock('../ReaderClient', () => () => null);

const ZHIZHAI = 'd59f2htm01du';

async function meta(search: Record<string, string>) {
    const { generateMetadata } = await import('../page.ssr');
    return generateMetadata({ params: Promise.resolve({ id: ZHIZHAI }), searchParams: Promise.resolve(search) });
}
async function page(search: Record<string, string>) {
    const { default: ReaderPage } = await import('../page.ssr');
    return ReaderPage({ params: Promise.resolve({ id: ZHIZHAI }), searchParams: Promise.resolve(search) });
}

beforeEach(() => {
    mockGetCurrentJson.mockReset();
    mockGetCurrentJson.mockImplementation(async (rel) =>
        rel === `items/${ZHIZHAI}/collated_edition/index.json` ? { juan_files: ['juan/011.json'] } : null);
});

describe('阅读页 page.ssr', () => {
    it('卷号查得到：200，canonical 指向本卷', async () => {
        const m = await meta({ kind: 'collated', juan: 'juan/011.json' });
        expect(m.alternates?.canonical).toBe(`/item/${ZHIZHAI}/read?kind=collated&juan=juan%2F011.json`);
        expect(m.robots).toBeUndefined();
        await expect(page({ kind: 'collated', juan: 'juan/011.json' })).resolves.toBeTruthy();
    });

    it('乱填的卷号：真 404 且 noindex，不出自指 canonical', async () => {
        const m = await meta({ kind: 'collated', juan: 'juan/999.json' });
        expect(m.robots).toEqual({ index: false, follow: false });
        expect(m.alternates).toBeUndefined();
        await expect(page({ kind: 'collated', juan: 'juan/999.json' })).rejects.toThrow('NEXT_NOT_FOUND');
    });

    it('目录查不了（网络错）：照常渲染，canonical 回落到不带卷号的地址', async () => {
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        mockGetCurrentJson.mockRejectedValue(new Error('HTTP 502'));
        const m = await meta({ kind: 'collated', juan: 'juan/011.json' });
        expect(m.alternates?.canonical).toBe(`/item/${ZHIZHAI}/read?kind=collated`);
        await expect(page({ kind: 'collated', juan: 'juan/011.json' })).resolves.toBeTruthy();
    });
});
