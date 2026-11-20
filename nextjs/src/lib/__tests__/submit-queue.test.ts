import { SubmitQueue } from '../submit-queue';

const tick = () => new Promise(r => setTimeout(r, 0));

describe('SubmitQueue', () => {
    it('同一格按点击顺序串行发，最新一次标 latest', async () => {
        const log: string[] = [];
        const q = new SubmitQueue(3);
        let release1!: () => void;
        const p1 = q.enqueue('a', () => new Promise<null>(r => { log.push('1 start'); release1 = () => { log.push('1 end'); r(null); }; }));
        await tick();
        const p2 = q.enqueue('a', async () => { log.push('2'); return null; });
        await tick();
        expect(log).toEqual(['1 start']);          // 第 2 次要等第 1 次发完
        release1();
        const [r1, r2] = await Promise.all([p1, p2]);
        expect(log).toEqual(['1 start', '1 end', '2']);
        expect(r1.latest).toBe(false);
        expect(r2.latest).toBe(true);
        expect(q.pending).toBe(0);
        expect(q.has('a')).toBe(false);
    });

    it('没开始发的旧提交被同格新提交顶掉', async () => {
        const q = new SubmitQueue(1);
        const calls: string[] = [];
        let release!: () => void;
        q.enqueue('x', () => new Promise<null>(r => { release = () => r(null); }));   // 占住唯一名额
        const old = q.enqueue('a', async () => { calls.push('old'); return null; });
        const fresh = q.enqueue('a', async () => { calls.push('new'); return null; });
        await tick();
        release();
        const [o, f] = await Promise.all([old, fresh]);
        expect(calls).toEqual(['new']);
        expect(o.skipped).toBe(true);
        expect(f.latest).toBe(true);
    });

    it('全局并发不超过上限；失败返回错误文案，抛出也算失败', async () => {
        const q = new SubmitQueue(2);
        let running = 0, peak = 0;
        const task = (err: string | null) => async () => { running++; peak = Math.max(peak, running); await tick(); running--; return err; };
        const rs = await Promise.all([q.enqueue('a', task(null)), q.enqueue('b', task('慢')), q.enqueue('c', task(null)), q.enqueue('d', async () => { throw new Error('x'); })]);
        expect(peak).toBeLessThanOrEqual(2);
        expect(rs.map(r => r.err)).toEqual([null, '慢', null, '提交失败，请稍后再试']);
    });

    it('pending 变化会通知', async () => {
        const seen: number[] = [];
        const q = new SubmitQueue(3, n => seen.push(n));
        await q.enqueue('a', async () => null);
        expect(seen).toEqual([1, 0]);
    });
});
