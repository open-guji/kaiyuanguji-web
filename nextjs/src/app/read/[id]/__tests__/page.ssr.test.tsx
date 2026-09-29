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
    getCurrentTextServer: async (rel: string) => (rel.endsWith('/text/juan/011.txt') ? '卷十一正文' : null),
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
        rel === `items/${ZHIZHAI}/collated_edition/index.json` ? { juan_files: ['juan/011.json'] }
            : rel === `items/${ZHIZHAI}/collated_edition/juan/011.json` ? { title: '卷十一', sections: [] }
                : null);
});

describe('阅读页 page.ssr', () => {
    it('卷号查得到（短形式 juan=011）：200，canonical 指向本卷的短形式', async () => {
        const m = await meta({ kind: 'collated', juan: '011' });
        expect(m.alternates?.canonical).toBe(`/item/${ZHIZHAI}/read?kind=collated&juan=011`);
        expect(m.title).toBe('直齋書錄解題 · 卷11 · 整理本');
        expect(m.robots).toBeUndefined();
        await expect(page({ kind: 'collated', juan: '011' })).resolves.toBeTruthy();
    });

    it('旧形式（juan=juan/011.json）：308 到短形式，已分享的链接不坏', async () => {
        const target = `/item/${ZHIZHAI}/read?kind=collated&juan=011`;
        await expect(page({ kind: 'collated', juan: 'juan/011.json' })).rejects.toThrow(`REDIRECT ${target}`);
        await expect(meta({ kind: 'collated', juan: 'juan/011.json' })).rejects.toThrow(`REDIRECT ${target}`);
    });

    it.each(['999', 'juan/999.json', '../x', 'juan/../011.json', '011.json'])('乱填的卷号 %s：真 404 且 noindex，不出自指 canonical', async (juan) => {
        const m = await meta({ kind: 'collated', juan });
        expect(m.robots).toEqual({ index: false, follow: false });
        expect(m.alternates).toBeUndefined();
        await expect(page({ kind: 'collated', juan })).rejects.toThrow('NEXT_NOT_FOUND');
    });

    it('目录查不了（网络错）：照常渲染，canonical 回落到不带卷号的地址', async () => {
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        mockGetCurrentJson.mockRejectedValue(new Error('HTTP 502'));
        const m = await meta({ kind: 'collated', juan: '011' });
        expect(m.alternates?.canonical).toBe(`/item/${ZHIZHAI}/read?kind=collated`);
        await expect(page({ kind: 'collated', juan: '011' })).resolves.toBeTruthy();
    });

    it('全文：title 与 description 用目录里的章名（「第三回」），不写死「卷3」；没有章名回落「卷N」', async () => {
        mockGetCurrentJson.mockImplementation(async (rel) =>
            rel === `items/${ZHIZHAI}/full_text/wikisource/index.json`
                ? { chapters: [{ n: 3, title: '第三回', file: '003.md' }, { n: 4, title: '', file: '004.md' }] }
                : null);
        const m = await meta({ kind: 'fulltext', key: 'wikisource', juan: '003' });
        expect(m.title).toBe('直齋書錄解題 · 第三回 · 全文');
        expect(m.description).toBe('直齋書錄解題第三回全文，在线阅读。');
        const m4 = await meta({ kind: 'fulltext', key: 'wikisource', juan: '004' });
        expect(m4.title).toBe('直齋書錄解題 · 卷4 · 全文');
        expect((await meta({ kind: 'fulltext', key: 'wikisource', juan: '009' })).robots).toEqual({ index: false, follow: false });
    });

    it('首屏数据随页面交给 ReaderClient（WEB2）：卷目录、本卷数据与正文', async () => {
        const el = (await page({ kind: 'collated', juan: '011' })) as { props: { seed: { collatedIndex?: unknown; calls?: Record<string, unknown> } } };
        expect(el.props.seed.collatedIndex).toEqual({ juan_files: ['juan/011.json'] });
        expect(Object.values(el.props.seed.calls ?? {})).toEqual([{ title: '卷十一', sections: [] }, '卷十一正文']);
    });

    it('首屏数据取不了：照常渲染，seed 为空，交给浏览器取', async () => {
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        mockGetCurrentJson.mockRejectedValue(new Error('HTTP 502'));
        const el = (await page({ kind: 'collated' })) as { props: { seed: unknown } };
        expect(el.props.seed).toEqual({});
    });

    it('按请求渲染：force-dynamic、不导出 generateStaticParams（否则读查询串 DYNAMIC_SERVER_USAGE，全 500）', async () => {
        const mod: Record<string, unknown> = await import('../page.ssr');
        expect(mod.dynamic).toBe('force-dynamic');
        expect(mod.generateStaticParams).toBeUndefined();
    });
});
