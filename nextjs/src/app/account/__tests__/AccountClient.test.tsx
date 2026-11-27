import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import AccountClient from '../AccountClient';
import { __resetMemberCache } from '../../../lib/use-member';

jest.mock('next/navigation', () => ({ useRouter: () => ({ push: jest.fn() }) }));

const calls: { url: string; body?: string }[] = [];
function mockFetch(nickResult: { status: number; body: unknown }, me: unknown = { success: true, email: 'a@b.c', role: 'reader', joinedAt: 1700000000, nickname: '旧名', code: 'K7QM-2XR9' }) {
  calls.length = 0;
  (global as any).fetch = jest.fn(async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: init?.body });
    if (url === '/api/auth/nickname') return { ok: nickResult.status < 400, status: nickResult.status, json: async () => nickResult.body };
    return { ok: true, status: 200, json: async () => me };
  });
}
beforeEach(() => __resetMemberCache());

describe('/account 昵称设置', () => {
  it('显示当前昵称，改了才能点保存，保存成功提示「已保存」并提交新昵称', async () => {
    mockFetch({ status: 200, body: { success: true, nickname: '新名' } });
    render(<AccountClient />);
    const input = (await screen.findByLabelText('昵称')) as HTMLInputElement;
    expect(input.value).toBe('旧名');
    const save = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(input, { target: { value: '新名' } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await screen.findByText('已保存');
    expect(JSON.parse(calls.find((c) => c.url === '/api/auth/nickname')!.body!)).toEqual({ nickname: '新名' });
  });

  it('服务端拒绝时显示原因', async () => {
    mockFetch({ status: 400, body: { success: false, error: '昵称不能像邮箱或网址' } });
    render(<AccountClient />);
    const input = await screen.findByLabelText('昵称');
    fireEvent.change(input, { target: { value: 'a@b.com' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('不能像邮箱'));
  });
});

describe('/account 会员号', () => {
  it('显示会员号，点复制写入剪贴板并提示「已复制」', async () => {
    mockFetch({ status: 200, body: { success: true } });
    const writeText = jest.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<AccountClient />);
    expect(await screen.findByText('K7QM-2XR9')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '复制' }));
    await screen.findByText('已复制');
    expect(writeText).toHaveBeenCalledWith('K7QM-2XR9');
  });
});
