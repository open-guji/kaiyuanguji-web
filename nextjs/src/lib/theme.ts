/**
 * 站点主题（overview#286 第 0 步）：朱砂（默认）与靛蓝。
 *
 * 开关是 `<html data-theme="zhusha|indigo">`；未设、空、值不认识一律按朱砂（样式只有 indigo 有覆盖）。
 * 选择存 localStorage（键 THEME_KEY），
 * 读写一律 try/catch——隐私窗口、清站点数据、被禁用时抛错，页面照常按朱砂渲染。
 * 首屏防闪：layout.tsx 在 <head> 放 THEME_INIT_SCRIPT，浏览器画第一帧前就设好属性；
 * 首次访问（存储里没有）和存储不可用时不设，即默认朱砂。
 */
export type ThemeName = 'zhusha' | 'indigo';

export const THEMES: { name: ThemeName; label: string }[] = [
  { name: 'zhusha', label: '朱砂' },
  { name: 'indigo', label: '靛藍' },
];

/** `<meta name="theme-color">`：浏览器地址栏／状态栏色，取各主题的主色 */
export const THEME_COLOR: Record<ThemeName, string> = { zhusha: '#9e2a2b', indigo: '#2e5266' };

export const THEME_KEY = 'kyg-theme';
export const DEFAULT_THEME: ThemeName = 'zhusha';

export function isTheme(v: unknown): v is ThemeName {
  return v === 'zhusha' || v === 'indigo';
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

/** 内联在 <head> 的防闪脚本：与 readStoredTheme / applyTheme 同逻辑，须自包含、不抛错 */
export const THEME_INIT_SCRIPT = `try{if(localStorage.getItem(${JSON.stringify(THEME_KEY)})==='indigo'){document.documentElement.setAttribute('data-theme','indigo');var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute('content',${JSON.stringify(THEME_COLOR.indigo)})}}catch(e){}`;
