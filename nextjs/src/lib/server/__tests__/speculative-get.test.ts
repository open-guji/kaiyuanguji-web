/**
 * @jest-environment node
 */
import { describe, it, expect, jest } from '@jest/globals';
import { withSpeculation } from '../speculative-get';

describe('withSpeculation（overview#345 PR②：投机预取）', () => {
    it('同参数的预取在路上：get 直接用它，底层只被调一次', async () => {
        const base = jest.fn(async (rel: string) => ({ rel }));
        const s = withSpeculation(base);
        s.prefetch('items/a/default/index.json');
        expect(s.pending()).toBe(1);
        await expect(s.get('items/a/default/index.json')).resolves.toEqual({ rel: 'items/a/default/index.json' });
        expect(base).toHaveBeenCalledTimes(1);
        expect(s.pending()).toBe(0);
    });

    it('参数不同（猜错了）：预取被忽略，按真实参数新发一次；没人要的预取留着不影响结果', async () => {
        const base = jest.fn(async (rel: string) => ({ rel }));
        const s = withSpeculation(base);
        s.prefetch('items/a/default/index.json');
        await expect(s.get('items/a/wikisource/index.json')).resolves.toEqual({ rel: 'items/a/wikisource/index.json' });
        expect(base.mock.calls.map((c) => c[0])).toEqual(['items/a/default/index.json', 'items/a/wikisource/index.json']);
        expect(s.pending()).toBe(1);
    });

    it('附加参数（maxBytes）参与匹配：不同的 maxBytes 不算同一个请求', async () => {
        const base = jest.fn(async (rel: string, max?: number) => `${rel}:${max}`);
        const s = withSpeculation(base);
        s.prefetch('x.txt', 256);
        await expect(s.get('x.txt', 256)).resolves.toBe('x.txt:256');
        expect(base).toHaveBeenCalledTimes(1);
        s.prefetch('y.txt', 256);
        await expect(s.get('y.txt', 1)).resolves.toBe('y.txt:1');
        expect(base).toHaveBeenCalledTimes(3);
    });

    it('预取失败：当没预取过，get 重新取一次（成功就成功，仍失败就抛，与直接调用一致）', async () => {
        let n = 0;
        const base = jest.fn(async (rel: string) => { n += 1; if (n === 1) throw new Error('HTTP 500'); return { rel }; });
        const s = withSpeculation(base);
        s.prefetch('a.json');
        await expect(s.get('a.json')).resolves.toEqual({ rel: 'a.json' });
        expect(base).toHaveBeenCalledTimes(2);

        const bad = withSpeculation(jest.fn(async () => { throw new Error('HTTP 503'); }));
        bad.prefetch('b.json');
        await expect(bad.get('b.json')).rejects.toThrow('HTTP 503');
    });

    it('没人消费的失败预取不产生未处理的 rejection', async () => {
        const unhandled = jest.fn();
        process.on('unhandledRejection', unhandled);
        const s = withSpeculation(jest.fn(async () => { throw new Error('boom'); }));
        s.prefetch('never.json');
        await new Promise((r) => setTimeout(r, 20));
        process.off('unhandledRejection', unhandled);
        expect(unhandled).not.toHaveBeenCalled();
    });

    it('一次预取只能被消费一次；同参数重复预取只发一次；底层同步抛错的预取被忽略', async () => {
        const base = jest.fn(async (rel: string) => rel);
        const s = withSpeculation(base);
        s.prefetch('a');
        s.prefetch('a');
        expect(base).toHaveBeenCalledTimes(1);
        await s.get('a');
        await s.get('a');
        expect(base).toHaveBeenCalledTimes(2);
        const thrower = withSpeculation((() => { throw new Error('sync'); }) as unknown as (rel: string) => Promise<string>);
        expect(() => thrower.prefetch('z')).not.toThrow();
        expect(thrower.pending()).toBe(0);
    });
});
