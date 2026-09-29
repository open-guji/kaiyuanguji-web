/**
 * @jest-environment node
 *
 * 阅读页原来的地址 /item/<id>/read?… → 308 /read/<id>?…，查询参数原样带过去（overview#267）。
 */
import { describe, it, expect, jest } from '@jest/globals';

jest.mock('next/navigation', () => ({
    permanentRedirect: (to: string) => { throw new Error(`REDIRECT ${to}`); },
}));

const ID = 'd59f2htm01du';

async function go(search: Record<string, string | string[] | undefined>) {
    const { default: Page } = await import('../page.ssr');
    return Page({ params: Promise.resolve({ id: ID }), searchParams: Promise.resolve(search) });
}

describe('旧阅读页地址 page.ssr', () => {
    it('查询参数原样带过去（含多值、不认识的）', async () => {
        await expect(go({ kind: 'collated', juan: '011' })).rejects.toThrow(`REDIRECT /read/${ID}?kind=collated&juan=011`);
        await expect(go({ kind: 'fulltext', key: 'a', juan: ['001', '002'], x: '1' }))
            .rejects.toThrow(`REDIRECT /read/${ID}?kind=fulltext&key=a&juan=001&juan=002&x=1`);
    });

    it('没有查询串就是干净的 /read/<id>', async () => {
        await expect(go({})).rejects.toThrow(`REDIRECT /read/${ID}`);
        await expect(go({ empty: undefined })).rejects.toThrow(`REDIRECT /read/${ID}`);
    });

    it('本页不进搜索引擎、按请求渲染，且不导出 generateStaticParams', async () => {
        const mod: Record<string, unknown> = await import('../page.ssr');
        expect(mod.dynamic).toBe('force-dynamic');
        expect(mod.generateStaticParams).toBeUndefined();
        const meta = await (mod.generateMetadata as () => Promise<{ robots?: unknown }>)();
        expect(meta.robots).toEqual({ index: false, follow: false });
    });
});
