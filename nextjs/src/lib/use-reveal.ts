'use client';

import { useEffect } from 'react';

/**
 * 滚动进场：观察页面中所有 `.reveal` 元素，进入视口时加 `.in-view`。
 *
 * 配合 globals.css 里的 `.reveal` / `.reveal.in-view` 使用。
 * 在最外层布局挂一次即可，新增节点通过 MutationObserver 自动纳入观察。
 *
 * 无障碍：用户开启「减少动态效果」时直接全部置为可见，不做动画。
 */
export function useReveal(): void {
    useEffect(() => {
        if (typeof window === 'undefined') return;

        const prefersReducedMotion = window.matchMedia?.(
            '(prefers-reduced-motion: reduce)'
        ).matches;

        const markAllVisible = () => {
            document
                .querySelectorAll('.reveal')
                .forEach((el) => el.classList.add('in-view'));
        };

        // 不支持 IntersectionObserver（或用户不要动效）时直接显示，避免内容永久隐藏
        if (prefersReducedMotion || typeof IntersectionObserver === 'undefined') {
            markAllVisible();
            return;
        }

        const observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (!entry.isIntersecting) continue;
                    entry.target.classList.add('in-view');
                    observer.unobserve(entry.target);
                }
            },
            { rootMargin: '0px 0px -10% 0px', threshold: 0.05 }
        );

        const observeAll = () => {
            document.querySelectorAll('.reveal:not(.in-view)').forEach((el) => {
                observer.observe(el);
            });
        };

        observeAll();

        // 路由切换 / 异步渲染出来的新节点也要纳入观察
        const mutationObserver = new MutationObserver(observeAll);
        mutationObserver.observe(document.body, { childList: true, subtree: true });

        return () => {
            observer.disconnect();
            mutationObserver.disconnect();
        };
    }, []);
}
