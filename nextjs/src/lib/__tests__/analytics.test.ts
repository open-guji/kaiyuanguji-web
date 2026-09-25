/**
 * 访问统计的闸（G-24）。与 error-report 一样，改错了没有症状：
 * 统计数字只会「看起来少了／多了」。两个方向都钉住。
 */
import { isAnalyticsUrl, isExcludedPath, shouldTrack } from '../analytics';

function nav(over: Record<string, unknown> = {}): Navigator {
    return { webdriver: false, doNotTrack: null, ...over } as unknown as Navigator;
}

describe('shouldTrack', () => {
    it('普通读者、公开页：统计', () => {
        expect(shouldTrack('/', nav())).toBe(true);
        expect(shouldTrack('/book-index', nav())).toBe(true);
        expect(shouldTrack('/administrator-notes', nav())).toBe(true); // 只是前缀像，不是 /admin
    });
    it('自动化浏览器：不统计', () => {
        expect(shouldTrack('/', nav({ webdriver: true }))).toBe(false);
    });
    it('/admin、/join 及其子页：不统计', () => {
        expect(shouldTrack('/admin', nav())).toBe(false);
        expect(shouldTrack('/admin/errors', nav())).toBe(false);
        expect(shouldTrack('/join', nav())).toBe(false);
    });
    it('Do Not Track / GPC：不统计', () => {
        expect(shouldTrack('/', nav({ doNotTrack: '1' }))).toBe(false);
        expect(shouldTrack('/', nav({ globalPrivacyControl: true }))).toBe(false);
        expect(shouldTrack('/', nav({ doNotTrack: '0' }))).toBe(true);
    });
});

describe('isExcludedPath', () => {
    it('精确前缀匹配', () => {
        expect(isExcludedPath('/admin')).toBe(true);
        expect(isExcludedPath('/admins')).toBe(false);
    });
});

describe('isAnalyticsUrl（被拦截时不进错误监控）', () => {
    it('统计脚本域名命中', () => {
        expect(isAnalyticsUrl('https://hm.baidu.com/hm.js?abc')).toBe(true);
        expect(isAnalyticsUrl('https://www.googletagmanager.com/gtag/js?id=G-X')).toBe(true);
    });
    it('本站和其他资源不误伤', () => {
        expect(isAnalyticsUrl('https://www.kaiyuanguji.com/_next/static/x.js')).toBe(false);
        expect(isAnalyticsUrl('https://www.baidu.com/')).toBe(false);
        expect(isAnalyticsUrl('not a url')).toBe(false);
        expect(isAnalyticsUrl(undefined)).toBe(false);
    });
});
