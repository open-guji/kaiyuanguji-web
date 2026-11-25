/**
 * @jest-environment node
 */
export {};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const loadCaps = () => import('../../../../edge-functions/api/auth/caps.js');

describe('功能权限（caps）', () => {
    test('角色预设：普通读者没有高清书影，审阅者能提交，管理员全部', async () => {
        const { effectiveCaps } = await loadCaps();
        expect(effectiveCaps({ role: 'reader' })).toEqual(['img.view', 'read']);
        expect(effectiveCaps({ role: 'reviewer' })).toContain('review.submit');
        expect(effectiveCaps({ role: 'reviewer' })).not.toContain('review.approve');
        expect(effectiveCaps({ role: 'admin' })).toContain('img.hires');
    });
    test('单独授予：按职业／审阅准确性给 review.submit，到期自动失效', async () => {
        const { effectiveCaps, hasCap } = await loadCaps();
        const now = 1_000_000;
        const m = { role: 'reader', caps: { 'review.submit': { src: 'review-score', exp: now + 10 }, 'img.hires': { src: 'paid', exp: now - 1 } } };
        expect(hasCap(m, 'review.submit', now)).toBe(true);
        expect(hasCap(m, 'img.hires', now)).toBe(false);
        expect(hasCap(m, 'review.submit', now + 11)).toBe(false);
    });
    test('可撤销角色预设里的某项；未知功能名被忽略；被移除成员无权限', async () => {
        const { effectiveCaps } = await loadCaps();
        expect(effectiveCaps({ role: 'editor', caps: { 'review.approve': { revoked: true }, 'hack.all': {} } })).not.toContain('review.approve');
        expect(effectiveCaps({ role: 'editor', caps: { 'hack.all': {} } })).not.toContain('hack.all');
        expect(effectiveCaps({ role: '', _deleted: true })).toEqual([]);
        expect(effectiveCaps(null)).toEqual([]);
    });
});
