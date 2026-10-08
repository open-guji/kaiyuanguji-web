/**
 * @jest-environment node
 *
 * overview#307 E 块：阅读页服务端——路径式地址按 manifest 与版本目录校验，查不到真 404，
 * 查不了时 canonical 回落到不带章号的地址；default 地址 308。
 * overview#322：页面是 ISR、不读查询串（旧查询串的换算只在中间件），条目与 manifest 两条取数链并行。
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mockGetCurrentJson = jest.fn<(rel: string) => Promise<unknown>>();
const mockGetItem = jest.fn(async (id: string, _opts?: unknown): Promise<unknown> => ({ entry: { id, type: id === 'hixhd2h9bk4b' ? 'entity' : 'work', title: '直齋書錄解題' }, source: 'h1', version: 'h1:r' }));
jest.mock('@/lib/server/item-data', () => ({
    getItemServer: (id: string, opts?: unknown) => mockGetItem(id, opts),
    getPromotionServer: async () => ({ status: 'absent' }),
    getCurrentJsonServer: (rel: string) => mockGetCurrentJson(rel),
    getCurrentTextServer: async (rel: string) => (rel.endsWith('/default/002.txt') ? '卷二正文' : null),
}));
jest.mock('next/navigation', () => ({
    notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
    redirect: (to: string) => { throw new Error(`REDIRECT ${to}`); },
    permanentRedirect: (to: string) => { throw new Error(`REDIRECT ${to}`); },
}));
jest.mock('../../ReaderClient', () => () => null);

const ZHIZHAI = 'd59f2htm01du';
const MANIFEST = {
    id: ZHIZHAI,
    versions: [
        // default 取全文型：阅读页对「目录型 default ＋ 全文版」的过滤另有用例（lib/__tests__/reader-manifest.test.ts、ReaderVersions.test.tsx，overview#456）
        { key: 'default', kind: 'transcription', label: '整理本', source: 'collated' },
        { key: 'wikisource', kind: 'transcription', label: '維基文庫', source: 'wikisource' },
        // 带版本名（edition_label，overview#307）
        { key: 'kanripo', kind: 'transcription', label: 'Kanripo', source: 'kanripo', edition_label: '四部叢刊本' },
    ],
};
const FILES: Record<string, unknown> = {
    [`items/${ZHIZHAI}/manifest.json`]: MANIFEST,
    [`items/${ZHIZHAI}/default/index.json`]: { chapters: [{ n: 1, file: '001', title: '經錄', has_json: true }, { n: 2, file: '002', title: '史錄', has_json: true }] },
    [`items/${ZHIZHAI}/default/002.json`]: { title: '史錄', sections: [] },
    // 默认版本本身就是维基文库转录（如伊尹）：title 不写版本名
    'items/d59f2evysmww/manifest.json': { id: 'd59f2evysmww', versions: [{ key: 'default', kind: 'transcription', label: '維基文庫', source_name: '維基文庫' }] },
    'items/d59f2evysmww/default/index.json': { chapters: [{ n: 1, file: '001', title: '伊尹' }] },
    [`items/${ZHIZHAI}/wikisource/index.json`]: { chapters: [{ n: 1, file: '001', title: '' }, { n: 2, file: '002', title: '卷二' }] },
    [`items/${ZHIZHAI}/kanripo/index.json`]: { chapters: [{ n: 1, file: '001', title: '卷一' }] },
};

async function meta(seg: string[] | undefined, id = ZHIZHAI) {
    const { generateMetadata } = await import('../page.ssr');
    return generateMetadata({ params: Promise.resolve({ id, seg }) });
}
type El = { type?: unknown; props: Record<string, any> };
/** 页面渲染出的整棵（ReaderClient ＋ 计时 script） */
async function pageTree(seg: string[] | undefined, id = ZHIZHAI) {
    const { default: ReaderPage } = await import('../page.ssr');
    jest.spyOn(console, 'log').mockImplementation(() => {});
    return (await ReaderPage({ params: Promise.resolve({ id, seg }) })) as El;
}
/** 页面里的 ReaderClient 元素（overview#322 起页面外层多了一个 Fragment，装计时 script） */
async function page(seg: string[] | undefined, id = ZHIZHAI) {
    const tree = await pageTree(seg, id);
    const kids = ([] as El[]).concat(tree.props.children);
    return kids[0];
}
function timingOf(tree: El): string {
    const kids = ([] as El[]).concat(tree.props.children);
    const tag = kids.find((k) => k?.props?.id === 'kyg-render-timing');
    return JSON.parse(tag!.props.dangerouslySetInnerHTML.__html) as string;
}

beforeEach(() => {
    mockGetCurrentJson.mockReset();
    mockGetCurrentJson.mockImplementation(async (rel) => FILES[rel] ?? null);
});

describe('阅读页 page.ssr（路径式地址）', () => {
    it.each(['assistant', 'assistant.md', 'roadmap_overview', 'typesetting.md'])('旧的说明页地址 /read/%s：308 到 /read/md/<名>，不查数据', async (id) => {
        const to = `REDIRECT /read/md/${id.replace(/\.md$/, '')}`;
        await expect(meta([], id)).rejects.toThrow(to);
        await expect(page(undefined, id)).rejects.toThrow(to);
        expect(mockGetCurrentJson).not.toHaveBeenCalled();
    });

    it('/read/<id>：主版本第一章 200；canonical 指向第一章的全形，title 是「书名 · 章名 · 版本名」', async () => {
        const m = await meta([]);
        expect(m.alternates?.canonical).toBe(`/read/${ZHIZHAI}/001`);
        expect(m.title).toBe('直斋书录解题 · 经录');
        expect(m.robots).toBeUndefined();
        expect(String(m.alternates?.canonical)).not.toContain('?');
    });

    it("取条目走 prefer: 'current'（只要书名与跳转信息，overview#322 B1）", async () => {
        mockGetItem.mockClear();
        await meta([]);
        expect(mockGetItem).toHaveBeenCalledWith(ZHIZHAI, { prefer: 'current' });
    });

    it('/read/<id>/<章>：canonical 是本章；章名进 title 与 description', async () => {
        const m = await meta(['002']);
        expect(m.alternates?.canonical).toBe(`/read/${ZHIZHAI}/002`);
        expect(m.title).toBe('直斋书录解题 · 史录');
        expect(m.description).toBe('直斋书录解题史录，在线阅读。');
    });

    it('默认版本就是维基文库转录：title、description 都不写版本名', async () => {
        const m = await meta(['001'], 'd59f2evysmww');
        expect(m.title).toBe('直斋书录解题 · 伊尹');
        expect(String(m.description)).not.toContain('維基文庫');
    });

    it('其他版本：/read/<id>/<key> 与 /read/<id>/<key>/<章>；目录里章名为空回落「卷N」', async () => {
        expect((await meta(['wikisource'])).alternates?.canonical).toBe(`/read/${ZHIZHAI}/wikisource/001`);
        expect((await meta(['wikisource'])).title).toBe('直斋书录解题 · 卷1 · 维基文库');
        const m = await meta(['wikisource', '002']);
        expect(m.alternates?.canonical).toBe(`/read/${ZHIZHAI}/wikisource/002`);
        expect(m.title).toBe('直斋书录解题 · 卷二 · 维基文库');
    });

    it('版本有 edition_label：title、og:title、description 写「版本名 · 来源名」（overview#307）', async () => {
        const m = await meta(['kanripo']);
        expect(m.title).toBe('直斋书录解题 · 卷一 · 四部丛刊本 · Kanripo');
        expect((m.openGraph as { title?: string }).title).toBe(m.title);
        expect(String(m.description)).toContain('四部丛刊本 · Kanripo');
    });

    it('地址里写了 default：308 到不带 default 的形式，元数据与页面都一样', async () => {
        await expect(page(['default'])).rejects.toThrow(`REDIRECT /read/${ZHIZHAI}`);
        await expect(meta(['default', '002'])).rejects.toThrow(`REDIRECT /read/${ZHIZHAI}/002`);
    });

    it.each([['999'], ['wikisource', '009'], ['nonesuch'], ['nonesuch', '001']])('乱填的地址 %j：真 404 且 noindex，不出自指 canonical', async (...seg) => {
        const m = await meta(seg);
        expect(m.robots).toEqual({ index: false, follow: false });
        expect(m.alternates).toBeUndefined();
        await expect(page(seg)).rejects.toThrow('NEXT_NOT_FOUND');
    });

    it.each([['Bad_Key'], ['manifest'], ['a', 'b', 'c'], ['wikisource', 'abc']])('形态不对的地址 %j：真 404', async (...seg) => {
        await expect(page(seg)).rejects.toThrow('NEXT_NOT_FOUND');
    });

    it('条目没有文本（没有 manifest）：真 404；人物等没有阅读页的类型也是', async () => {
        mockGetCurrentJson.mockResolvedValue(null);
        await expect(page([])).rejects.toThrow('NEXT_NOT_FOUND');
        await expect(page([], 'hixhd2h9bk4b')).rejects.toThrow('NEXT_NOT_FOUND');
    });

    it('查不了（网络错）：照常渲染，canonical 回落到不带章号的地址', async () => {
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        mockGetCurrentJson.mockRejectedValue(new Error('HTTP 502'));
        const m = await meta(['wikisource', '002']);
        expect(m.alternates?.canonical).toBe(`/read/${ZHIZHAI}/wikisource`);
        await expect(page(['wikisource', '002'])).resolves.toBeTruthy();
    });

    it('首屏数据随页面交给 ReaderClient（WEB2）：manifest、版本目录、本章 md 与 json', async () => {
        const el = (await page(['002'])) as { props: { initial: unknown; seed: { calls?: Record<string, unknown> } } };
        expect(el.props.initial).toEqual({ key: undefined, chapter: '002' });
        const calls = el.props.seed.calls ?? {};
        expect(Object.values(calls)).toEqual([MANIFEST, FILES[`items/${ZHIZHAI}/default/index.json`], { md: '卷二正文', json: { title: '史錄', sections: [] } }]);
    });

    it('没给章号：落实到第一章交给阅读器；其他版本带 key', async () => {
        const a = (await page([])) as { props: { initial: unknown } };
        expect(a.props.initial).toEqual({ key: undefined, chapter: '001' });
        const b = (await page(['wikisource'])) as { props: { initial: unknown } };
        expect(b.props.initial).toEqual({ key: 'wikisource', chapter: '001' });
    });

    it('首屏数据取不了：照常渲染，seed 为空，交给浏览器取', async () => {
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        mockGetCurrentJson.mockRejectedValue(new Error('HTTP 502'));
        const el = (await page([])) as { props: { seed: unknown } };
        expect(el.props.seed).toEqual({});
    });

    it('ISR（overview#322）：revalidate 1 小时、构建时不预渲染；不再 force-dynamic', async () => {
        const mod: Record<string, unknown> = await import('../page.ssr');
        expect(mod.dynamic).toBeUndefined();
        expect(mod.revalidate).toBe(3600);
        expect(mod.dynamicParams).toBe(true);
        await expect((mod.generateStaticParams as () => Promise<unknown[]>)()).resolves.toEqual([]);
    });

    it('条目与 manifest 两条取数链并行：条目还没回来，manifest 已经在取（overview#322）', async () => {
        let release: (v: unknown) => void = () => {};
        mockGetItem.mockImplementationOnce(() => new Promise((r) => { release = r; }));
        const p = page(['002']);
        await new Promise((r) => setTimeout(r, 0));
        expect(mockGetCurrentJson).toHaveBeenCalledWith(`items/${ZHIZHAI}/manifest.json`);
        release({ entry: { id: ZHIZHAI, type: 'work', title: '直齋書錄解題' }, source: 'h1', version: 'h1:r' });
        await expect(p).resolves.toBeTruthy();
    });

    it('被并条目：跳到目标的阅读页（同一版本与章）', async () => {
        mockGetItem.mockResolvedValueOnce({ entry: { id: ZHIZHAI, merged_into: 'd59f2evs8ni8' }, source: 'h1', version: 'h1:r' });
        await expect(page(['wikisource', '002'])).rejects.toThrow('REDIRECT /read/d59f2evs8ni8/wikisource/002');
    });

    it('overview#322 方案 D：首次渲染分段计时写进不渲染的 script（Server-Timing 语法），并打一行函数日志', async () => {
        const logs: string[] = [];
        const tree = await pageTree(['002']);
        (console.log as unknown as jest.Mock).mock.calls.forEach((c) => logs.push(String(c[0])));
        const t = timingOf(tree);
        for (const name of ['item', 'check', 'redirect', 'preload', 'total']) expect(t).toMatch(new RegExp(`(^|, )${name};dur=\\d+`));
        expect(t).toMatch(/inst;desc="req=\d+ up=\d+s"$/);
        expect(logs.some((l) => l.startsWith(`[reader-timing] /read/${ZHIZHAI}/002 item;dur=`))).toBe(true);
    });
});
