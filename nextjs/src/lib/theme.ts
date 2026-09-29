/**
 * 站点主题（overview#286 第 0 步）：朱砂（默认）与靛蓝。
 *
 * 开关是 `<html data-theme="indigo">`；朱砂 = 不设该属性。选择存 localStorage（键 THEME_KEY），
 * 读写一律 try/catch——隐私窗口、清站点数据、被禁用时抛错，页面照常按朱砂渲染。
 * 首屏防闪：layout.tsx 在 <head> 放 THEME_INIT_SCRIPT，浏览器画第一帧前就设好属性；
 * 首次访问（存储里没有）和存储不可用时不设，即默认朱砂。
 */
export type ThemeName = 'vermilion' | 'indigo';

export const THEMES: { name: ThemeName; label: string }[] = [
  { name: 'vermilion', label: '朱砂' },
  { name: 'indigo', label: '靛藍' },
];

export const THEME_KEY = 'kyg-theme';
export const DEFAULT_THEME: ThemeName = 'vermilion';

export function isTheme(v: unknown): v is ThemeName {
  return v === 'vermilion' || v === 'indigo';
}

export function readStoredTheme(): ThemeName {
  try {
    const v = window.localStorage.getItem(THEME_KEY);
    return isTheme(v) ? v : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/** 应用到 <html>：朱砂去掉属性，其余写属性 */
export function applyTheme(theme: ThemeName): void {
  const el = document.documentElement;
  if (theme === DEFAULT_THEME) el.removeAttribute('data-theme');
  else el.setAttribute('data-theme', theme);
}

export function storeTheme(theme: ThemeName): void {
  try {
    if (theme === DEFAULT_THEME) window.localStorage.removeItem(THEME_KEY);
    else window.localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* 存不了就只在本页生效 */
  }
}

/** 当前 <html> 上生效的主题（客户端） */
export function currentTheme(): ThemeName {
  const v = document.documentElement.getAttribute('data-theme');
  return isTheme(v) ? v : DEFAULT_THEME;
}

/** 内联在 <head> 的防闪脚本：与 readStoredTheme / applyTheme 同逻辑，须自包含、不抛错 */
export const THEME_INIT_SCRIPT = `try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)});if(t==='indigo')document.documentElement.setAttribute('data-theme',t)}catch(e){}`;
