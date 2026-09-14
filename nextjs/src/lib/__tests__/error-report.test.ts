/**
 * 前端错误上报的闸。
 *
 * 这里改错的代价是不对称的：漏报没有任何症状——错误日志静悄悄地变少，
 * 看起来就像「站点变好了」。2026-09-14 加「自动化浏览器不上报」这条时，
 * 一个手滑就能把所有真实读者的上报一起关掉，而且不会有人发现。
 * 所以两个方向都要钉住：自动化不许发、真实浏览器必须发。
 */

const beacons: { url: string }[] = [];

function setWebdriver(v: boolean | undefined) {
    Object.defineProperty(window.navigator, 'webdriver', {
        value: v,
        configurable: true,
    });
}

async function freshModule() {
    // 模块内有「本会话同指纹只发一次」的去重表，每个用例要拿干净的一份
    let mod!: typeof import('../error-report');
    await jest.isolateModulesAsync(async () => {
        mod = await import('../error-report');
    });
    return mod;
}

beforeEach(() => {
    beacons.length = 0;
    Object.defineProperty(window.navigator, 'sendBeacon', {
        value: (url: string) => {
            beacons.push({ url });
            return true;
        },
        configurable: true,
    });
    setWebdriver(false);
});

describe('reportError', () => {
    it('真实浏览器：正常上报', async () => {
        const { reportError } = await freshModule();
        reportError({ kind: 'js', message: '真实错误' });
        expect(beacons).toHaveLength(1);
        expect(beacons[0].url).toBe('/api/track-error');
    });

    it('自动化浏览器（navigator.webdriver）：一条都不发', async () => {
        setWebdriver(true);
        const { reportError } = await freshModule();
        reportError({ kind: 'js', message: 'e2e 自造的错误' });
        reportError({ kind: 'fetch', message: 'entry 不存在 (404)', resource: 'nonexistent000', status: 404 });
        expect(beacons).toHaveLength(0);
    });

    it('navigator.webdriver 为 undefined 时按真实浏览器处理，不能误伤', async () => {
        setWebdriver(undefined);
        const { reportError } = await freshModule();
        reportError({ kind: 'js', message: '老浏览器没有这个属性' });
        expect(beacons).toHaveLength(1);
    });

    it('同一指纹本会话只发一次', async () => {
        const { reportError } = await freshModule();
        reportError({ kind: 'js', message: '重复的' });
        reportError({ kind: 'js', message: '重复的' });
        expect(beacons).toHaveLength(1);
    });

    it('空 message 不发', async () => {
        const { reportError } = await freshModule();
        reportError({ kind: 'js', message: '' });
        expect(beacons).toHaveLength(0);
    });

    it('每页有上限，异常风暴刷不爆 KV', async () => {
        const { reportError } = await freshModule();
        for (let i = 0; i < 50; i += 1) reportError({ kind: 'js', message: '第 ' + i + ' 条' });
        expect(beacons.length).toBeLessThanOrEqual(20);
        expect(beacons.length).toBeGreaterThan(0);
    });
});
