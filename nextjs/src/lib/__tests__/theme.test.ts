import {
  DEFAULT_THEME, THEME_INIT_SCRIPT, THEME_KEY, applyTheme, currentTheme, isTheme, readStoredTheme, storeTheme,
} from '../theme';

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

describe('theme', () => {
  it('默认朱砂；靛藍写 data-theme，朱砂去掉属性', () => {
    expect(DEFAULT_THEME).toBe('vermilion');
    applyTheme('indigo');
    expect(document.documentElement.getAttribute('data-theme')).toBe('indigo');
    expect(currentTheme()).toBe('indigo');
    applyTheme('vermilion');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    expect(currentTheme()).toBe('vermilion');
  });

  it('存取：靛藍存下来，朱砂（默认）清掉；未知值回退朱砂', () => {
    storeTheme('indigo');
    expect(window.localStorage.getItem(THEME_KEY)).toBe('indigo');
    expect(readStoredTheme()).toBe('indigo');
    storeTheme('vermilion');
    expect(window.localStorage.getItem(THEME_KEY)).toBeNull();
    window.localStorage.setItem(THEME_KEY, 'purple');
    expect(readStoredTheme()).toBe('vermilion');
    expect(isTheme('purple')).toBe(false);
  });

  it('localStorage 读写抛错时不崩，按默认', () => {
    const spy = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    const spy2 = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    expect(readStoredTheme()).toBe('vermilion');
    expect(() => storeTheme('indigo')).not.toThrow();
    spy.mockRestore();
    spy2.mockRestore();
  });

  it('防闪脚本：存了靛藍才设属性；没存、存的是别的、读存储抛错都不设也不抛', () => {
    const run = () => new Function(THEME_INIT_SCRIPT)();
    run();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    window.localStorage.setItem(THEME_KEY, 'indigo');
    run();
    expect(document.documentElement.getAttribute('data-theme')).toBe('indigo');
    document.documentElement.removeAttribute('data-theme');
    window.localStorage.setItem(THEME_KEY, '"><script>');
    run();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
    const spy = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    expect(run).not.toThrow();
    spy.mockRestore();
  });
});
