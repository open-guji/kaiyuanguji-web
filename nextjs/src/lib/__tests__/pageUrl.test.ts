import { isSameSiteUrl } from '../pageUrl';

describe('isSameSiteUrl（G-23 第二批 §一·10）', () => {
    const HERE = 'https://www.kaiyuanguji.com/book-index?id=x';

    it('本站绝对地址：true', () => {
        expect(isSameSiteUrl('https://www.kaiyuanguji.com/feedback', HERE)).toBe(true);
    });

    it('本站相对路径：true', () => {
        expect(isSameSiteUrl('/book-index?id=y', HERE)).toBe(true);
    });

    it('外站域名：false（不能渲染成链接）', () => {
        expect(isSameSiteUrl('https://evil.example/', HERE)).toBe(false);
    });

    it('子域名不算同站：false', () => {
        expect(isSameSiteUrl('https://cdn.kaiyuanguji.com/x', HERE)).toBe(false);
    });

    it('javascript: 等非 http(s) 协议：false', () => {
        expect(isSameSiteUrl('javascript:alert(1)', HERE)).toBe(false);
    });

    it('空值：false', () => {
        expect(isSameSiteUrl('', HERE)).toBe(false);
        expect(isSameSiteUrl(undefined, HERE)).toBe(false);
    });

    it('格式不合法的地址：false（不抛异常）', () => {
        expect(isSameSiteUrl('http:://', HERE)).toBe(false);
    });
});
