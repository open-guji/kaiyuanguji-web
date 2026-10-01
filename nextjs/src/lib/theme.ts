/**
 * 站点外观（overview#286 第 0 步 → #291 v4 P0）：配色＋版式两个维度。
 *
 * 配色：朱砂（默认）／靛青／墨，开关是 `<html data-theme="zhusha|indigo|ink">`；
 * 版式：疏朗（默认）／界栏，开关是 `<html data-layout="airy|boxed">`。
 * 未设、空、值不认识一律按默认（样式只有 indigo／ink／boxed 有覆盖）。老用户存的 `zhusha`／`indigo` 原样有效。
 * 选择存 localStorage（键 THEME_KEY），
 * 读写一律 try/catch——隐私窗口、清站点数据、被禁用时抛错，页面照常按朱砂渲染。
 * 首屏防闪：layout.tsx 在 <head> 放 THEME_INIT_SCRIPT，浏览器画第一帧前就设好属性；
 * 首次访问（存储里没有）和存储不可用时不设，即默认朱砂。
 */
export type ThemeName = 'zhusha' | 'indigo' | 'ink';

export const THEMES: { name: ThemeName; label: string }[] = [
  { name: 'zhusha', label: '朱砂' },
  { name: 'indigo', label: '靛青' },
  { name: 'ink', label: '墨' },
];

/** `<meta name="theme-color">`：浏览器地址栏／状态栏色，取各主题的主色 */
export const THEME_COLOR: Record<ThemeName, string> = { zhusha: '#9e2a2b', indigo: '#2e5266', ink: '#3b4a58' };

export const THEME_KEY = 'kyg-theme';
export const DEFAULT_THEME: ThemeName = 'zhusha';

export function isTheme(v: unknown): v is ThemeName {
  return v === 'zhusha' || v === 'indigo' || v === 'ink';
}

/** 任意值 → 合法主题名，非法回退默认 */
export function normalizeTheme(v: unknown): ThemeName {
  return isTheme(v) ? v : DEFAULT_THEME;
}

export function readStoredTheme(): ThemeName {
  try {
    return normalizeTheme(window.localStorage.getItem(THEME_KEY));
  } catch {
    return DEFAULT_THEME;
  }
}

/** 应用到 <html>（并同步 theme-color）；非法值按默认。返回实际生效的主题 */
export function applyTheme(theme: unknown): ThemeName {
  const t = normalizeTheme(theme);
  document.documentElement.setAttribute('data-theme', t);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[t]);
  return t;
}

export function storeTheme(theme: ThemeName): void {
  try {
    window.localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* 存不了就只在本页生效 */
  }
}

/** 当前 <html> 上生效的主题（客户端） */
export function currentTheme(): ThemeName {
  return normalizeTheme(document.documentElement.getAttribute('data-theme'));
}

// ── 版式 ──

export type LayoutName = 'airy' | 'boxed';

export const LAYOUTS: { name: LayoutName; label: string; hint: string }[] = [
  { name: 'airy', label: '疏朗', hint: '留白分区' },
  { name: 'boxed', label: '界栏', hint: '框线分区' },
];

export const LAYOUT_KEY = 'kyg-layout';
export const DEFAULT_LAYOUT: LayoutName = 'airy';

export function isLayout(v: unknown): v is LayoutName {
  return v === 'airy' || v === 'boxed';
}

export function normalizeLayout(v: unknown): LayoutName {
  return isLayout(v) ? v : DEFAULT_LAYOUT;
}

export function readStoredLayout(): LayoutName {
  try {
    return normalizeLayout(window.localStorage.getItem(LAYOUT_KEY));
  } catch {
    return DEFAULT_LAYOUT;
  }
}

export function applyLayout(layout: unknown): LayoutName {
  const l = normalizeLayout(layout);
  document.documentElement.setAttribute('data-layout', l);
  return l;
}

export function storeLayout(layout: LayoutName): void {
  try {
    window.localStorage.setItem(LAYOUT_KEY, layout);
  } catch {
    /* 存不了就只在本页生效 */
  }
}

export function currentLayout(): LayoutName {
  return normalizeLayout(document.documentElement.getAttribute('data-layout'));
}

/**
 * 内联在 <head> 的防闪脚本：读两个键；存的是 indigo／ink 才改 data-theme（并同步 theme-color）、
 * 存的是 boxed 才改 data-layout，其余保持 SSR 默认（朱砂＋疏朗）。须自包含、不抛错。
 */
export const THEME_INIT_SCRIPT =
  `try{var c=${JSON.stringify(THEME_COLOR)},t=localStorage.getItem(${JSON.stringify(THEME_KEY)});`
  + `if(t==='indigo'||t==='ink'){document.documentElement.setAttribute('data-theme',t);var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute('content',c[t])}`
  + `if(localStorage.getItem(${JSON.stringify(LAYOUT_KEY)})==='boxed')document.documentElement.setAttribute('data-layout','boxed')}catch(e){}`;
