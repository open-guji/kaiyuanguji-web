import { decideMember, nextMember, safeNext, signSession, memberKey } from '../ba-members.ssr';

describe('ba-members 桥接', () => {
  test('活成员：登录，保留角色和 tokenVersion', () => {
    const m = { role: 'editor', tokenVersion: 3, verified: false };
    expect(decideMember(m, false).action).toBe('login');
    expect(nextMember(m, 100)).toMatchObject({ role: 'editor', tokenVersion: 3, verified: true });
  });
  test('老成员没有 tokenVersion 时补 1', () => {
    expect(nextMember({ role: 'reviewer' }, 100).tokenVersion).toBe(1);
  });
  test('非成员：注册关则拒绝，开则注册为 reader', () => {
    expect(decideMember(null, false).action).toBe('blocked');
    expect(decideMember(null, true).action).toBe('register');
    expect(nextMember(null, 100)).toEqual({ role: 'reader', joinedAt: 100, invitedBy: 'self-register', tokenVersion: 1, verified: true, uid: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/) });
  });
  test('被移除的邮箱不能自助回来', () => {
    expect(decideMember({ role: '', _deleted: true, tokenVersion: 2 }, true).action).toBe('blocked');
  });
  test('safeNext 只收站内相对路径', () => {
    expect(safeNext('/read/x?a=1')).toBe('/read/x?a=1');
    for (const bad of ['//evil.com', 'https://evil.com', '/\\evil', null, '']) expect(safeNext(bad as string | null)).toBe('/');
  });
  test('JWT 结构与键编码', async () => {
    const t = await signSession('a@b.com', 2, 's', 1000);
    const p = JSON.parse(Buffer.from(t.split('.')[1], 'base64').toString());
    expect(p).toEqual({ sub: 'a@b.com', iat: 1000, exp: 1000 + 180 * 24 * 3600, tv: 2 });
    expect(memberKey('a@b.com')).toBe('member:a~0040~b.com');
  });
});
