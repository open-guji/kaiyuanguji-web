/**
 * @jest-environment node
 */
import { describe, it, expect } from '@jest/globals';
import { startRenderTiming, serverTimingValue, timed } from '../render-timing';

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
});
