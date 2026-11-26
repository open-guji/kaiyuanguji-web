import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import AccountMenu from '../AccountMenu';
import { __resetMemberCache } from '../../../lib/use-member';

function mockMe(status: number, body: unknown) {
  (global as any).fetch = jest.fn(async () => ({ status, json: async () => body }));
}
beforeEach(() => __resetMemberCache());

describe('AccountMenu（顶栏账号入口）', () => {
  it('未登录：显示「登录」按钮，点开在下方弹出邮箱框，Esc 关闭', async () => {
    mockMe(401, { success: false });
    render(<AccountMenu />);
    const btn = await screen.findByRole('button', { name: '登录' });
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(btn);
    expect(screen.getByRole('dialog', { name: '登录' })).toBeTruthy();
    expect(screen.getByLabelText('邮箱')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('已登录：换成人形图标，指向 /account', async () => {
    mockMe(200, { success: true, email: 'a@b.c', role: 'reader' });
    render(<AccountMenu />);
    const link = await waitFor(() => screen.getByRole('link', { name: '我的账号' }));
    expect(link.getAttribute('href')).toBe('/account');
    expect(screen.queryByRole('button', { name: '登录' })).toBeNull();
  });
});
