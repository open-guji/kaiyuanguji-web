/**
 * fixtures/edge-retry.ts 自测（overview#484）：假响应，不碰网络、不依赖 TARGET。npm run test:selftest。
 */
import { test, expect } from '@playwright/test';
import { describeFailure, edgeHeaders, getWithEdgeRetry } from '../fixtures/edge-retry';

const res = (status: number, headers: Record<string, string> = {}) => ({ status: () => status, headers: () => headers });
function seq(...statuses: number[]) {
    let i = 0;
    return async () => res(statuses[Math.min(i++, statuses.length - 1)]);
}

test('525 两次后 200：通过，退避 2s／5s', async () => {
    const waits: number[] = [];
    const { res: r, retries } = await getWithEdgeRetry(seq(525, 525, 200), { sleep: async (ms) => void waits.push(ms) });
    expect(r.status()).toBe(200);
    expect(retries).toBe(2);
    expect(waits).toEqual([2000, 5000]);
});

test('503／522／524 同样重试', async () => {
    for (const code of [503, 522, 524]) {
        const { res: r, retries } = await getWithEdgeRetry(seq(code, 200), { sleep: async () => {} });
        expect(r.status()).toBe(200);
        expect(retries).toBe(1);
    }
});

test('持续 525：重试 3 次（2s／5s／10s）后返回最后一次响应，说明里写明次数与 EdgeOne 头', async () => {
    const waits: number[] = [];
    const headers = { 'eo-log-uuid': 'u-1', 'eo-cache-status': 'MISS', date: 'Wed, 08 Oct 2026 04:40:00 GMT' };
    let calls = 0;
    const { res: r, retries, firstStatus } = await getWithEdgeRetry(async () => { calls++; return res(525, headers); }, { sleep: async (ms) => void waits.push(ms) });
    expect(calls).toBe(4);
    expect(waits).toEqual([2000, 5000, 10000]);
    expect(r.status()).toBe(525);
    expect(describeFailure(r, retries, firstStatus)).toBe('HTTP 525（525后重试 3 次仍失败） [EO-LOG-UUID=u-1 Eo-Cache-Status=MISS Date=Wed, 08 Oct 2026 04:40:00 GMT]');
});

test('404、500 不重试；没有头信息时说明保持简洁', async () => {
    for (const code of [404, 500]) {
        let calls = 0;
        const { retries, res: r, firstStatus } = await getWithEdgeRetry(async () => { calls++; return res(code); }, { sleep: async () => { throw new Error('不该等待'); } });
        expect(calls).toBe(1);
        expect(retries).toBe(0);
        expect(describeFailure(r, retries, firstStatus)).toBe(`HTTP ${code}`);
    }
    expect(edgeHeaders(res(525, { date: 'x' }))).toBe('Date=x');
});

test('重试途中拿到过的 EdgeOne 头，最后一次没带头也保留', async () => {
    let i = 0;
    const { res: r, retries, firstStatus, hdr } = await getWithEdgeRetry(
        async () => (i++ === 0 ? res(525, { 'eo-log-uuid': 'u-early' }) : res(525)),
        { sleep: async () => {} },
    );
    expect(describeFailure(r, retries, firstStatus, hdr)).toBe('HTTP 525（525后重试 3 次仍失败） [EO-LOG-UUID=u-early]');
});
