// SITE_ENV 在 constants.ts 是模块加载时读的 process.env，每个用例不同取值
// 必须 resetModules 后动态 import 才能生效。
describe('app/robots.ts（T1 测试站全禁）', () => {
    const ORIGINAL_ENV = process.env.NEXT_PUBLIC_SITE_ENV;

    afterEach(() => {
        process.env.NEXT_PUBLIC_SITE_ENV = ORIGINAL_ENV;
        jest.resetModules();
    });

    it('staging 下全站 disallow，且不发 sitemap', async () => {
        jest.resetModules();
        process.env.NEXT_PUBLIC_SITE_ENV = 'staging';
        const { default: robots } = await import('../robots');
        const result = robots();
        expect(result.rules).toEqual({ userAgent: '*', disallow: '/' });
        expect(result.sitemap).toBeUndefined();
    });

    it('正式站保留原有规则与 sitemap', async () => {
        jest.resetModules();
        delete process.env.NEXT_PUBLIC_SITE_ENV;
        const { default: robots } = await import('../robots');
        const result = robots();
        expect(result.rules).toEqual({ userAgent: '*', allow: '/', disallow: '/private/' });
        expect(result.sitemap).toContain('/sitemap.xml');
    });
});
