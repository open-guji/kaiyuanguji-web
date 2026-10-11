/**
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import { startRenderTiming, serverTimingValue, timed, hopName, withHopTiming } from '../render-timing';

describe('render-timing（overview#322 方案 D）', () => {
    it('每次 start 请求号加一，记 uptime 与起点', () => {
        const a = startRenderTiming(1_000_000_000_000);
        const b = startRenderTiming(1_000_000_000_500);
        expect(b.reqNo).toBe(a.reqNo + 1);
        expect(b.uptimeMs - a.uptimeMs).toBe(500);
    });

    it('timed：成功、抛错（含 redirect）都记一段', async () => {
        const t = startRenderTiming();
        await expect(timed(t, 'ok', Promise.resolve(1))).resolves.toBe(1);
        await expect(timed(t, 'boom', Promise.reject(new Error('NEXT_REDIRECT')))).rejects.toThrow('NEXT_REDIRECT');
        expect(t.marks.map(([n]) => n)).toEqual(['ok', 'boom']);
        expect(t.marks.every(([, d]) => d >= 0)).toBe(true);
    });

    it('serverTimingValue：Server-Timing 语法，末尾 total 与 inst', () => {
        const t = { reqNo: 1, uptimeMs: 2_400, startedAt: 1000, marks: [['item', 812], ['check', 640]] as [string, number][] };
        expect(serverTimingValue(t, 2530)).toBe('item;dur=812, check;dur=640, total;dur=1530, inst;desc="req=1 up=2s"');
    });

    it('hopName：按文件名给每一跳起名（overview#345 PR①）', () => {
        expect(hopName('items/abc/manifest.json')).toBe('h:manifest');
        expect(hopName('items/abc/default/index.json')).toBe('h:index');
        expect(hopName('items/abc/default/017.json')).toBe('h:chapter-json');
        expect(hopName('items/abc/default/017.txt')).toBe('h:chapter-txt');
        expect(hopName('items/abc/default/017.json?v=k1')).toBe('h:chapter-json');
        expect(hopName('latest.json.bak')).toBe('h:other');
    });

    it('withHopTiming：结果与抛错原样透传，参数原样传给原函数，每次调用多记一段', async () => {
        const t = startRenderTiming();
        const seen: unknown[][] = [];
        const get = async (rel: string, extra?: number) => {
            seen.push([rel, extra]);
            if (rel.endsWith('boom.json')) throw new Error('HTTP 500');
            return rel.endsWith('missing.json') ? null : { rel };
        };
        const w = withHopTiming(t, get);
        await expect(w('items/a/manifest.json')).resolves.toEqual({ rel: 'items/a/manifest.json' });
        await expect(w('items/a/missing.json', 7)).resolves.toBeNull();
        await expect(w('items/a/boom.json')).rejects.toThrow('HTTP 500');
        expect(seen).toEqual([['items/a/manifest.json', undefined], ['items/a/missing.json', 7], ['items/a/boom.json', undefined]]);
        expect(t.marks.map(([n]) => n)).toEqual(['h:manifest', 'h:chapter-json', 'h:chapter-json']);
    });
});
