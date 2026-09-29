import { fireEvent, render, screen } from '@testing-library/react';
import ThemeToggle from '../ThemeToggle';
import { THEME_KEY } from '../../../lib/theme';

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.setAttribute('data-theme', 'zhusha');
  document.head.innerHTML = '<meta name="theme-color" content="#9e2a2b">';
});

describe('ThemeToggle', () => {
  it('data-theme 是非法值时按朱砂显示选中', () => {
    document.documentElement.setAttribute('data-theme', 'purple');
    render(<ThemeToggle />);
    expect(screen.getByRole('radio', { name: '朱砂' }).getAttribute('aria-checked')).toBe('true');
  });

  it('两个单选：朱砂、靛藍；默认朱砂选中', () => {
    render(<ThemeToggle />);
    expect(screen.getByRole('radiogroup', { name: '主題' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: '朱砂' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: '靛藍' }).getAttribute('aria-checked')).toBe('false');
  });

  it('点靛藍：<html data-theme>、localStorage、theme-color 同步；再点朱砂还原', () => {
    render(<ThemeToggle />);
    fireEvent.click(screen.getByRole('radio', { name: '靛藍' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('indigo');
    expect(window.localStorage.getItem(THEME_KEY)).toBe('indigo');
    expect(document.querySelector('meta[name="theme-color"]')!.getAttribute('content')).toBe('#2e5266');
    expect(screen.getByRole('radio', { name: '靛藍' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: '朱砂' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('zhusha');
    expect(document.querySelector('meta[name="theme-color"]')!.getAttribute('content')).toBe('#9e2a2b');
  });

  it('挂载时按 <html> 上已设的主题（防闪脚本设的）显示选中项', () => {
    document.documentElement.setAttribute('data-theme', 'indigo');
    render(<ThemeToggle />);
    expect(screen.getByRole('radio', { name: '靛藍' }).getAttribute('aria-checked')).toBe('true');
  });
});
