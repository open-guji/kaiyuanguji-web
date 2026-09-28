// SITE_ENV 在 constants.ts 是模块加载时读的 process.env，每个用例不同取值
// 必须 resetModules 后动态 import 才能生效。
describe('app/robots.ts（T1 测试站全禁）', () => {
    const ORIGINAL_ENV = process.env.NEXT_PUBLIC_SITE_ENV;
    const ORIGINAL_MODE = process.env.KYG_RENDER_MODE;

    afterEach(() => {
        if (ORIGINAL_ENV === undefined) delete process.env.NEXT_PUBLIC_SITE_ENV;
        else process.env.NEXT_PUBLIC_SITE_ENV = ORIGINAL_ENV;
        if (ORIGINAL_MODE === undefined) delete process.env.KYG_RENDER_MODE;
        else process.env.KYG_RENDER_MODE = ORIGINAL_MODE;
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
        delete process.env.KYG_RENDER_MODE;
        const { default: robots } = await import('../robots');
        const result = robots();
        expect(result.rules).toEqual({ userAgent: '*', allow: '/', disallow: '/private/' });
        expect(result.sitemap).toContain('/sitemap.xml');
    });

    it('正式站全栈构建：sitemap 指向 sitemap-index.xml（/sitemap.xml 只剩静态页）', async () => {
        jest.resetModules();
        delete process.env.NEXT_PUBLIC_SITE_ENV;
        process.env.KYG_RENDER_MODE = 'fullstack';
        const { default: robots } = await import('../robots');
        const { SITE_URL } = await import('@/lib/constants');
        const result = robots();
        expect(result.rules).toEqual({ userAgent: '*', allow: '/', disallow: '/private/' });
        expect(result.sitemap).toBe(`${SITE_URL}/sitemap-index.xml`);
    });

    it('staging 全栈构建仍全禁、不发 sitemap', async () => {
        jest.resetModules();
        process.env.NEXT_PUBLIC_SITE_ENV = 'staging';
        process.env.KYG_RENDER_MODE = 'fullstack';
        const { default: robots } = await import('../robots');
        const result = robots();
        expect(result.rules).toEqual({ userAgent: '*', disallow: '/' });
        expect(result.sitemap).toBeUndefined();
    });
});
