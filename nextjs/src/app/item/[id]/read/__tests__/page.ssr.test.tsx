/**
 * @jest-environment node
 *
 * 阅读页上一版的地址 /item/<id>/read?… → 308 新路径式地址（overview#267；overview#307 E 块）。
 * 旧查询串（kind／key／juan）按该条目的 manifest 换算，其余参数丢掉。
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const mockGetCurrentJson = jest.fn<(rel: string) => Promise<unknown>>();
jest.mock('@/lib/server/item-data', () => ({ getCurrentJsonServer: (rel: string) => mockGetCurrentJson(rel) }));
jest.mock('next/navigation', () => ({
    redirect: (to: string) => { throw new Error(`TEMP ${to}`); },
    permanentRedirect: (to: string) => { throw new Error(`REDIRECT ${to}`); },
}));

const ID = 'd59f2htm01du';
const MANIFEST = { versions: [{ key: 'default', kind: 'collated', source: 'collated' }, { key: 'wikisource', kind: 'transcription', source: 'wikisource' }] };

async function go(search: Record<string, string | string[] | undefined>) {
    const { default: Page } = await import('../page.ssr');
    return Page({ params: Promise.resolve({ id: ID }), searchParams: Promise.resolve(search) });
}

beforeEach(() => {
    mockGetCurrentJson.mockReset();
    mockGetCurrentJson.mockResolvedValue(MANIFEST);
});

describe('旧阅读页地址 page.ssr', () => {
    it('旧查询串按 manifest 换算：整理本是 default 不写 key，维基是另一份', async () => {
        await expect(go({ kind: 'collated', juan: '011' })).rejects.toThrow(`REDIRECT /read/${ID}/011`);
        await expect(go({ kind: 'fulltext', key: 'wikisource-01', juan: ['1', '2'], x: '1' })).rejects.toThrow(`REDIRECT /read/${ID}/wikisource/001`);
    });

    it('没有旧参数就是干净的 /read/<id>，不查数据', async () => {
        await expect(go({})).rejects.toThrow(`REDIRECT /read/${ID}`);
        await expect(go({ empty: undefined })).rejects.toThrow(`REDIRECT /read/${ID}`);
        expect(mockGetCurrentJson).not.toHaveBeenCalled();
    });

    it('条目没有文本（没有 manifest）：去条目页', async () => {
        mockGetCurrentJson.mockResolvedValue(null);
        await expect(go({ kind: 'collated' })).rejects.toThrow(`REDIRECT /item/${ID}`);
    });

    it('取 manifest 出错：临时跳条目页（不 500，也不发会被缓存的 308）', async () => {
        mockGetCurrentJson.mockRejectedValue(new Error('cos down'));
        await expect(go({ kind: 'collated' })).rejects.toThrow(`TEMP /item/${ID}`);
    });

    it('本页不进搜索引擎、按请求渲染，且不导出 generateStaticParams', async () => {
        const mod: Record<string, unknown> = await import('../page.ssr');
        expect(mod.dynamic).toBe('force-dynamic');
        expect(mod.generateStaticParams).toBeUndefined();
        const meta = await (mod.generateMetadata as () => Promise<{ robots?: unknown }>)();
        expect(meta.robots).toEqual({ index: false, follow: false });
    });
});
