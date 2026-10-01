/**
 * 全站繁简偏好（用户 9-30 反馈，overview#322：繁简切换挪到顶栏右上角，所有页面都有）。
 *
 * 顶栏不能引 book-index-ui（单文件包，顶层就引 opencc、react-markdown，首页等静态页会被拖大），
 * 所以偏好放在这里：一个极小的外部 store（localStorage＋同页事件＋跨标签页 storage 事件）。
 * 用组件库的页面用 components/common/BimLocaleProvider 把组件库的 LocaleProvider 接成受控，跟着它走。
 *
 * 存储键沿用组件库自己的 'bim-locale'，老用户存的值继续有效。
 * 首帧（含服务端渲染）一律简体，挂载后再读存的值——与组件库原先的做法一致，水合不报不一致。
 */
import { useCallback, useSyncExternalStore } from 'react';

export type SiteLocale = 'zh-Hans' | 'zh-Hant';

export const LOCALE_STORAGE_KEY = 'bim-locale';
const CHANGE_EVENT = 'og-locale-change';
const DEFAULT_LOCALE: SiteLocale = 'zh-Hans';

export function readSiteLocale(): SiteLocale {
  try {
    return localStorage.getItem(LOCALE_STORAGE_KEY) === 'zh-Hant' ? 'zh-Hant' : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}

export function writeSiteLocale(locale: SiteLocale): void {
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    /* 无痕模式等：存不下也照样通知本页 */
  }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: locale }));
}

// 存不下时（无痕模式）以内存值为准
let memo: SiteLocale | null = null;

function subscribe(onChange: () => void): () => void {
  const onLocal = (e: Event) => {
    memo = (e as CustomEvent<SiteLocale>).detail;
    onChange();
  };
  const onStorage = (e: StorageEvent) => {
    if (e.key === LOCALE_STORAGE_KEY) {
      memo = null;
      onChange();
    }
  };
  window.addEventListener(CHANGE_EVENT, onLocal);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onLocal);
    window.removeEventListener('storage', onStorage);
  };
}

const getSnapshot = (): SiteLocale => memo ?? readSiteLocale();
const getServerSnapshot = (): SiteLocale => DEFAULT_LOCALE;

/** 当前繁简偏好与设置函数 */
export function useSiteLocale(): [SiteLocale, (locale: SiteLocale) => void] {
  const locale = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const set = useCallback((next: SiteLocale) => writeSiteLocale(next), []);
  return [locale, set];
}
