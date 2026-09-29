/**
 * @jest-environment node
 *
 * 搜索页 title（overview#267 P2-9）：全栈构建按 searchParams 出，静态导出构建不读（读了会构建失败）。
 */
import { afterEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('../book-index/BookIndexClient', () => () => null);

const saved = { mode: process.env.KYG_RENDER_MODE, pub: process.env.NEXT_PUBLIC_MODE };
afterEach(() => {
    if (saved.mode === undefined) delete process.env.KYG_RENDER_MODE; else process.env.KYG_RENDER_MODE = saved.mode;
    if (saved.pub === undefined) delete process.env.NEXT_PUBLIC_MODE; else process.env.NEXT_PUBLIC_MODE = saved.pub;
});

async function meta(sp: Record<string, string | string[] | undefined>) {
    const { generateMetadata } = await import('../book-index/page');
    return generateMetadata({ searchParams: Promise.resolve(sp) });
}

describe('book-index generateMetadata', () => {
    it('全栈构建：带检索词的 title 是「<q> - 搜索」（根布局补站名）', async () => {
        process.env.KYG_RENDER_MODE = 'fullstack';
        expect(await meta({ q: '朱熹' })).toEqual({ title: '朱熹 - 搜索' });
        expect(await meta({ q: ['史記', 'x'] })).toEqual({ title: '史記 - 搜索' });
    });
    it('没有检索词、空白检索词、带 id 的详情视图：不设 title', async () => {
        process.env.KYG_RENDER_MODE = 'fullstack';
        expect(await meta({})).toEqual({});
        expect(await meta({ q: '  ' })).toEqual({});
        expect(await meta({ q: '朱熹', id: 'd59f20aowb9c' })).toEqual({});
    });
    it('静态导出构建（不是 fullstack 也不是 local）：不读 searchParams、不设 title', async () => {
        delete process.env.KYG_RENDER_MODE;
        delete process.env.NEXT_PUBLIC_MODE;
        // 'then' 要放过：Promise.resolve(proxy) 会探测它；其余属性一读就抛
        const sp = new Proxy({}, { get(_t, k) { if (k === 'then') return undefined; throw new Error('静态导出下读了 searchParams'); } });
        const { generateMetadata } = await import('../book-index/page');
        await expect(generateMetadata({ searchParams: Promise.resolve(sp) })).resolves.toEqual({});
    });
});
