import {
  DEFAULT_THEME, THEME_COLOR, THEME_INIT_SCRIPT, THEME_KEY, applyTheme, currentTheme, isTheme, normalizeTheme,
  readStoredTheme, storeTheme,
  DEFAULT_LAYOUT, LAYOUT_KEY, applyLayout, currentLayout, isLayout, normalizeLayout, readStoredLayout, storeLayout,
} from '../theme';

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-layout');
  document.head.innerHTML = '<meta name="theme-color" content="#9e2a2b">';
});

const themeColor = () => document.querySelector('meta[name="theme-color"]')!.getAttribute('content');

describe('theme', () => {
  it('无存储、无属性时默认朱砂', () => {
    expect(DEFAULT_THEME).toBe('zhusha');
    expect(readStoredTheme()).toBe('zhusha');
    expect(currentTheme()).toBe('zhusha');
  });

  it('applyTheme 写 data-theme，并同步 theme-color', () => {
    expect(applyTheme('indigo')).toBe('indigo');
    expect(document.documentElement.getAttribute('data-theme')).toBe('indigo');
    expect(themeColor()).toBe(THEME_COLOR.indigo);
    expect(applyTheme('zhusha')).toBe('zhusha');
    expect(document.documentElement.getAttribute('data-theme')).toBe('zhusha');
    expect(themeColor()).toBe(THEME_COLOR.zhusha);
  });

  it('非法值回退朱砂：applyTheme、data-theme 属性、存储里的值', () => {
    expect(normalizeTheme('purple')).toBe('zhusha');
    expect(isTheme('purple')).toBe(false);
    expect(applyTheme('purple')).toBe('zhusha');
    expect(document.documentElement.getAttribute('data-theme')).toBe('zhusha');
    document.documentElement.setAttribute('data-theme', '"><x');
    expect(currentTheme()).toBe('zhusha');
    window.localStorage.setItem(THEME_KEY, 'purple');
    expect(readStoredTheme()).toBe('zhusha');
  });

  it('存取往返；没有 theme-color 节点时 applyTheme 不抛', () => {
    storeTheme('indigo');
    expect(window.localStorage.getItem(THEME_KEY)).toBe('indigo');
    expect(readStoredTheme()).toBe('indigo');
    document.head.innerHTML = '';
    expect(() => applyTheme('indigo')).not.toThrow();
  });

  it('localStorage 读写抛错时不崩，按默认', () => {
    const spy = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    const spy2 = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    expect(readStoredTheme()).toBe('zhusha');
    expect(() => storeTheme('indigo')).not.toThrow();
    spy.mockRestore();
    spy2.mockRestore();
  });

  it('防闪脚本：存了靛藍才改属性和 theme-color；没存、非法值、读存储抛错都不改也不抛', () => {
    const run = () => new Function(THEME_INIT_SCRIPT)();
    document.documentElement.setAttribute('data-theme', 'zhusha');
    run();
    expect(document.documentElement.getAttribute('data-theme')).toBe('zhusha');
    window.localStorage.setItem(THEME_KEY, 'indigo');
    run();
    expect(document.documentElement.getAttribute('data-theme')).toBe('indigo');
    expect(themeColor()).toBe(THEME_COLOR.indigo);
    document.documentElement.setAttribute('data-theme', 'zhusha');
    window.localStorage.setItem(THEME_KEY, '"><script>');
    run();
    expect(document.documentElement.getAttribute('data-theme')).toBe('zhusha');
    const spy = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    expect(run).not.toThrow();
    spy.mockRestore();
  });
});

describe('v4 外观：墨与版式', () => {
  it('三种配色都合法；老用户存的 zhusha／indigo 原样有效，不需要迁移', () => {
    for (const t of ['zhusha', 'indigo', 'ink'] as const) {
      window.localStorage.setItem(THEME_KEY, t);
      expect(readStoredTheme()).toBe(t);
    }
    expect(applyTheme('ink')).toBe('ink');
    expect(document.documentElement.getAttribute('data-theme')).toBe('ink');
    expect(themeColor()).toBe('#222221');
  });

  it('版式：默认疏朗；存取往返；非法值回退疏朗', () => {
    expect(DEFAULT_LAYOUT).toBe('airy');
    expect(readStoredLayout()).toBe('airy');
    expect(currentLayout()).toBe('airy');
    expect(applyLayout('boxed')).toBe('boxed');
    expect(document.documentElement.getAttribute('data-layout')).toBe('boxed');
    storeLayout('boxed');
    expect(window.localStorage.getItem(LAYOUT_KEY)).toBe('boxed');
    expect(readStoredLayout()).toBe('boxed');
    expect(isLayout('grid')).toBe(false);
    expect(normalizeLayout('grid')).toBe('airy');
    expect(applyLayout('grid')).toBe('airy');
    document.documentElement.setAttribute('data-layout', '"><x');
    expect(currentLayout()).toBe('airy');
  });

  it('防闪脚本读两个键：ink／boxed 才改属性（ink 同步 theme-color）；没存、非法值、存储抛错都不改也不抛', () => {
    const run = () => new Function(THEME_INIT_SCRIPT)();
    run();
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();
    expect(document.documentElement.getAttribute('data-layout')).toBeNull();
    window.localStorage.setItem(THEME_KEY, 'ink');
    window.localStorage.setItem(LAYOUT_KEY, 'boxed');
    run();
    expect(document.documentElement.getAttribute('data-theme')).toBe('ink');
    expect(document.documentElement.getAttribute('data-layout')).toBe('boxed');
    expect(themeColor()).toBe('#222221');
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-layout');
    window.localStorage.setItem(THEME_KEY, 'purple');
    window.localStorage.setItem(LAYOUT_KEY, 'grid');
    run();
    expect(document.documentElement.getAttribute('data-theme')).toBeNull();
    expect(document.documentElement.getAttribute('data-layout')).toBeNull();
    const spy = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    expect(run).not.toThrow();
    spy.mockRestore();
  });
});
