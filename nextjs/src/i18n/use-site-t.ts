'use client';

import { useSiteLocale } from '@/lib/site-locale';
import { getSiteT, type SiteT } from './translate';

/** 当前繁简偏好下的 t()；首帧（含服务端渲染）是简体，挂载后跟随存的偏好 */
export function useSiteT(): SiteT {
    const [locale] = useSiteLocale();
    return getSiteT(locale);
}
