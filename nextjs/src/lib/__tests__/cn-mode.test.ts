import { buildCnCsp, CN_ALLOWED_HOSTS, CN_MODE_INIT_SCRIPT, isCnReachable, parseCnMode } from '../cn-mode';

describe('cn-mode', () => {
    it('parseCnMode：1／block 挡，report 只标，其余关', () => {
        expect(parseCnMode('1')).toBe('block');
        expect(parseCnMode('block')).toBe('block');
        expect(parseCnMode('report')).toBe('report');
        for (const v of ['0', '', null, undefined, 'x']) expect(parseCnMode(v)).toBe('off');
    });

    it('白名单含数据域名，不含境外域名', () => {
        expect(isCnReachable('data.openguji.com')).toBe(true);
        expect(isCnReachable('hm.baidu.com')).toBe(true);
        for (const h of ['www.googletagmanager.com', 'raw.githubusercontent.com', 'cdn.jsdelivr.net', 'archive.org', 'upload.wikimedia.org']) {
            expect(isCnReachable(h)).toBe(false);
        }
    });

    it('CSP 的图片／连接都只放行白名单', () => {
        const csp = buildCnCsp();
        expect(csp).toContain('img-src');
        expect(csp).toContain('https://data.openguji.com');
        expect(csp).not.toMatch(/google|github|jsdelivr|archive\.org|wikimedia/);
        expect(CN_ALLOWED_HOSTS.length).toBeGreaterThan(3);
    });

    it('内联脚本是合法 JS', () => {
        expect(() => new Function(CN_MODE_INIT_SCRIPT)).not.toThrow();
    });
});
