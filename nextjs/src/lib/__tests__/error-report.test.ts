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

    it('统计脚本被广告拦截器挡掉：不发（G-24）', async () => {
        const { reportError } = await freshModule();
        reportError({ kind: 'resource', message: '资源加载失败: script', resource: 'https://hm.baidu.com/hm.js?abc' });
        reportError({ kind: 'resource', message: '资源加载失败: script', resource: 'https://www.googletagmanager.com/gtag/js?id=G-X' });
        expect(beacons).toHaveLength(0);
        reportError({ kind: 'resource', message: '资源加载失败: script', resource: 'https://www.kaiyuanguji.com/_next/static/chunks/x.js' });
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

    it('浏览器扩展的资源不进监控（15 丙类噪音）', async () => {
        const { reportError } = await freshModule();
        reportError({ kind: 'resource', message: '资源加载失败: img', resource: 'chrome-extension://emnkfkdgmefakhhcinlafcopidbjgmcf/assets/search.png' });
        reportError({ kind: 'resource', message: '资源加载失败: img', resource: 'moz-extension://abc123/assets/icon.png' });
        reportError({ kind: 'resource', message: '资源加载失败: img', resource: 'safari-extension://xyz/assets/icon.png' });
        expect(beacons).toHaveLength(0);
        // 真实站内资源仍上报
        reportError({ kind: 'resource', message: '资源加载失败: img', resource: '/images/open-guji-logo.webp' });
        reportError({ kind: 'resource', message: '资源加载失败: script', resource: 'https://www.kaiyuanguji.com/_next/static/chunks/636-1d1a429932ba7508.js' });
        expect(beacons).toHaveLength(2);
    });

    it('扩展 scheme 判断不误伤普通 URL', async () => {
        const { reportError } = await freshModule();
        // 包含 extension 字样但不是 scheme 前缀的不应被过滤
        reportError({ kind: 'resource', message: '资源加载失败: img', resource: 'https://example.com/chrome-extension-test.png' });
        expect(beacons).toHaveLength(1);
    });

    it('扩展注入的 JS 错误（source 为 extension URL）也不上报', async () => {
        const { reportError } = await freshModule();
        reportError({ kind: 'js', message: 'Script error', source: 'chrome-extension://abc123/content.js:1:100' });
        reportError({ kind: 'js', message: 'Uncaught', source: 'moz-extension://xyz/background.js:10:5' });
        expect(beacons).toHaveLength(0);
        // 真实 JS 错误仍上报
        reportError({ kind: 'js', message: 't.slice is not a function', source: 'https://www.kaiyuanguji.com/_next/static/chunks/app/page.js:1:200' });
        expect(beacons).toHaveLength(1);
    });

    it('16 噪音类 JS 异常不进监控（Script error./空/Uncaught/广告）', async () => {
        const { reportError } = await freshModule();
        reportError({ kind: 'js', message: 'Script error.' });
        reportError({ kind: 'js', message: '' });
        reportError({ kind: 'js', message: 'Uncaught' });
        reportError({ kind: 'js', message: 'The ad loading process exceeded the timeout. Resetting ad loader.' });
        // 扩展栈首帧
        reportError({ kind: 'js', message: 't.slice is not a function', stack: 'Error: t.slice\n at chrome-extension://abc/content.js:1:10' });
        expect(beacons).toHaveLength(0);
        // 真实 JS 缺陷仍上报（signal is aborted 不在此过滤，属 meili 超时真缺陷）
        reportError({ kind: 'js', message: 't.slice is not a function', source: 'https://www.kaiyuanguji.com/_next/static/chunks/app/page.js:1:200' });
        expect(beacons).toHaveLength(1);
    });

    it('payload 为空或 undefined 时不抛异常', async () => {
        const { reportError } = await freshModule();
        // @ts-expect-error 故意传空值验证守卫顺序
        reportError(undefined);
        // @ts-expect-error
        reportError(null);
        expect(beacons).toHaveLength(0);
        // 之后正常上报仍可用
        reportError({ kind: 'js', message: '后续正常' });
        expect(beacons).toHaveLength(1);
    });
});

describe('reportError 带版本（DBG）', () => {
    const SHA = 'c'.repeat(40);
    const realFetch = global.fetch;
    afterEach(() => {
        delete process.env.NEXT_PUBLIC_WEB_COMMIT;
        global.fetch = realFetch;
    });

    it('每条上报带 web（构建注入的代码 commit）与 data（数据 commitId）', async () => {
        process.env.NEXT_PUBLIC_WEB_COMMIT = SHA;
        // 走 fetch 分支拿到 body 原文（sendBeacon 的 Blob 在 jsdom 里读不出来）
        Object.defineProperty(window.navigator, 'sendBeacon', { value: undefined, configurable: true });
        const sent: string[] = [];
        global.fetch = jest.fn(async (_u: unknown, init?: RequestInit) => {
            sent.push(String(init?.body));
            return new Response('{}');
        }) as unknown as typeof fetch;
        const { reportError, setRelease } = await freshModule();
        setRelease('501935e5be70');
        reportError({ kind: 'js', message: '带版本的错误' });
        expect(sent).toHaveLength(1);
        const b = JSON.parse(sent[0]);
        expect(b.web).toBe(SHA);
        expect(b.data).toBe('501935e5be70');
        expect(b.release).toBe('501935e5be70'); // 老字段保留，兼容旧查看页
    });
});
