'use client';

import { useEffect, useState } from 'react';
import { MOVED_HASH } from '@/lib/site-hosts';
import { useSiteT } from '@/i18n/use-site-t';

const KEY = 'kyg-moved-banner';

function read(): string | null {
    try { return sessionStorage.getItem(KEY); } catch { return null; }
}
function write(v: string): void {
    try { sessionStorage.setItem(KEY, v); } catch { /* 隐私模式读不了存储：本页关掉就算 */ }
}

/**
 * 旧域名 kaiyuanguji.com 301 过来的访客（地址带 MOVED_HASH）在页面最上方看到一条窄横幅，提醒新域名、请更新书签。
 * 看到片段就记进 sessionStorage 并把片段从地址栏摘掉（刷新、站内跳转后仍显示，直到点「×」）；
 * 点 × 后本标签页内不再出现。不是旧域名过来的访客什么也看不到（首帧渲染为空，不占版面、不影响 SSR 缓存）。
 */
export default function MovedBanner() {
    const t = useSiteT();
    const [show, setShow] = useState(false);

    useEffect(() => {
        if (window.location.hash === MOVED_HASH) {
            if (read() !== 'closed') write('open');
            const { pathname, search } = window.location;
            window.history.replaceState(window.history.state, '', pathname + search);
        }
        setShow(read() === 'open');
    }, []);

    if (!show) return null;
    return (
        <div
            role="status"
            data-testid="moved-banner"
            className="flex items-center justify-center gap-3 px-3 py-1 text-center text-xs"
            style={{ backgroundColor: 'var(--color-tint)', color: 'var(--color-ink-2)', borderBottom: '1px solid var(--color-tint-2)' }}
        >
            <span>{t('nav.moved')}</span>
            <button
                type="button"
                aria-label={t('nav.movedClose')}
                onClick={() => { write('closed'); setShow(false); }}
                className="px-1 text-sm leading-none"
                style={{ color: 'inherit' }}
            >
                ×
            </button>
        </div>
    );
}
