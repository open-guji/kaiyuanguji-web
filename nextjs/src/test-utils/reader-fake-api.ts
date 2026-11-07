import type { ReaderApi, ReaderChapterCtx } from 'book-index-ui';

export interface FakeCell { anchor: string; char: string; page?: number; col?: number }

/** 测试用的阅读器接口：只实现插件会用到的几项，记下 refresh／scrollTo 调用 */
export function fakeApi(o: {
    cells?: FakeCell[];
    state?: Record<string, unknown>;
    ctx?: Partial<ReaderChapterCtx>;
    rects?: Record<string, DOMRect | null>;
    locate?: ReaderApi['locate'];
}) {
    const calls = { refresh: [] as Array<string | undefined>, scrollTo: [] as Array<[string, unknown]> };
    const cells = (o.cells ?? []).map((c, i) => ({ page: 1, col: 1 + i, ...c }));
    const api = {
        ctx: {
            entryId: '96mid1ogzk', versionKey: 'v1', chapterKey: '002', chapter: { file: '002' }, version: { key: 'v1' },
            transport: {}, viewport: 'wide', ...o.ctx,
        } as unknown as ReaderChapterCtx,
        state: <T,>(id: string) => (o.state ?? {})[id] as T | undefined,
        cells,
        textCells: [],
        scrollTo: (a: string, opts?: unknown) => { calls.scrollTo.push([a, opts]); },
        rectOf: (a: string) => o.rects?.[a] ?? null,
        locate: o.locate ?? (() => null),
        refresh: (id?: string) => { calls.refresh.push(id); },
        prefs: {} as never,
        setPref: () => {},
        t: (k: string) => k,
        convert: (s: string) => s,
    } as ReaderApi;
    return { api, calls };
}

export const rect = (left: number, top: number, w = 24, h = 24) =>
    ({ left, top, width: w, height: h, right: left + w, bottom: top + h, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
