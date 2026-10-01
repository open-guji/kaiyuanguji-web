import { fireEvent, render, screen, within } from '@testing-library/react';
import AppearancePicker from '../AppearancePicker';
import { LAYOUT_KEY, THEME_KEY } from '../../../lib/theme';

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.setAttribute('data-theme', 'indigo');
  document.documentElement.setAttribute('data-layout', 'airy');
  document.head.innerHTML = '<meta name="theme-color" content="#9e2a2b">';
});

const openPanel = () => fireEvent.click(screen.getByRole('button', { name: '外观设置' }));

describe('AppearancePicker（外观面板）', () => {
  it('默认收起；按钮有可访问名称，aria-expanded 随开合', () => {
    render(<AppearancePicker />);
    const btn = screen.getByRole('button', { name: '外观设置' });
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('group', { name: '外观设置' })).toBeNull();
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('group', { name: '外观设置' })).toBeTruthy();
  });

  it('版式两选、配色三选（单选组，有名字）；默认＝疏朗＋靛青（overview#337 B1）；含「设置保存在本浏览器，全站通用」', () => {
    render(<AppearancePicker />);
    openPanel();
    const ly = screen.getByRole('radiogroup', { name: '版式' });
    expect(within(ly).getAllByRole('radio').map((r) => r.textContent)).toEqual(['疏朗留白分区', '界栏框线分区']);
    const th = screen.getByRole('radiogroup', { name: '配色' });
    expect(within(th).getAllByRole('radio').map((r) => r.textContent?.slice(0, 2).replace(/宣|米|素/, ''))).toEqual(['朱砂', '靛青', '墨']);
    expect(within(ly).getByRole('radio', { name: /疏朗/ }).getAttribute('aria-checked')).toBe('true');
    expect(within(th).getByRole('radio', { name: /靛青/ }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('设置保存在本浏览器，全站通用')).toBeTruthy();
  });

  it('选界栏：<html data-layout>、localStorage 同步；选墨：data-theme、localStorage、theme-color 同步', () => {
    render(<AppearancePicker />);
    openPanel();
    fireEvent.click(screen.getByRole('radio', { name: /界栏/ }));
    expect(document.documentElement.getAttribute('data-layout')).toBe('boxed');
    expect(window.localStorage.getItem(LAYOUT_KEY)).toBe('boxed');
    expect(screen.getByRole('radio', { name: /界栏/ }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: /墨/ }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('ink');
    expect(window.localStorage.getItem(THEME_KEY)).toBe('ink');
    expect(document.querySelector('meta[name="theme-color"]')!.getAttribute('content')).toBe('#3b4a58');
    // 还原
    fireEvent.click(screen.getByRole('radio', { name: /疏朗/ }));
    fireEvent.click(screen.getByRole('radio', { name: /靛青/ }));
    expect(document.documentElement.getAttribute('data-layout')).toBe('airy');
    expect(document.documentElement.getAttribute('data-theme')).toBe('indigo');
  });

  it('挂载时按 <html> 上已设的值（防闪脚本设的）显示选中项；非法值按默认', () => {
    document.documentElement.setAttribute('data-theme', 'zhusha');
    document.documentElement.setAttribute('data-layout', 'boxed');
    const { unmount } = render(<AppearancePicker />);
    openPanel();
    expect(screen.getByRole('radio', { name: /朱砂/ }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: /界栏/ }).getAttribute('aria-checked')).toBe('true');
    unmount();
    document.documentElement.setAttribute('data-theme', 'purple');
    document.documentElement.setAttribute('data-layout', 'grid');
    render(<AppearancePicker />);
    openPanel();
    expect(screen.getByRole('radio', { name: /靛青/ }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: /疏朗/ }).getAttribute('aria-checked')).toBe('true');
  });

  it('存储不可用时选择仍生效于本页；Esc 关闭并把焦点还给按钮；点面板外关闭', () => {
    const spy = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    render(<div><AppearancePicker /><p>外面</p></div>);
    openPanel();
    fireEvent.click(screen.getByRole('radio', { name: /界栏/ }));
    expect(document.documentElement.getAttribute('data-layout')).toBe('boxed');
    spy.mockRestore();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: '外观设置' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '外观设置' }));
    openPanel();
    fireEvent.mouseDown(screen.getByText('外面'));
    expect(screen.queryByRole('group', { name: '外观设置' })).toBeNull();
  });
});
