'use client';

import { useSiteT } from './use-site-t';
import type { SiteMessageKey } from './translate';

/**
 * 服务端组件里放界面文字用：<T k="about.title" />。
 * 服务端渲染出简体（首帧），挂载后跟随繁简偏好。
 */
export default function T({ k, vars }: { k: SiteMessageKey; vars?: Record<string, string | number> }) {
    const t = useSiteT();
    return <>{t(k, vars)}</>;
}
