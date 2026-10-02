'use client';

import { useEffect } from 'react';

/**
 * 注册 /sw-nav-retry.js（overview#322）：/read/… 与 /item/… 的整页导航失败时自动重试一次。
 * 页面加载完、空闲时才注册，不占首屏；注册失败静默（不支持 Service Worker 的浏览器照旧）。
 * 第一次来本站时还没装上，从第二个页面起生效。
 */
export default function NavRetryWorker() {
    useEffect(() => {
        if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
        const register = () => {
            navigator.serviceWorker.register('/sw-nav-retry.js', { scope: '/' }).catch(() => {});
        };
        if (document.readyState === 'complete') register();
        else window.addEventListener('load', register, { once: true });
        return () => window.removeEventListener('load', register);
    }, []);
    return null;
}
