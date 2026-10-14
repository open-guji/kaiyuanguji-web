'use client';

import { useEffect, useState } from 'react';
import type { RefObject } from 'react';
import { findQueryNode, parseFtParams, type FtParams } from '@/lib/fulltext/fulltext-locate';
import { useSiteT } from '@/i18n/use-site-t';

/**
 * 阅读页的全文搜索定位（GUJI-163 / F6 步 4，第一档）：
 * 地址带 `?ft=<章>:<起>-<止>&ftq=` 且章号与当前章一致时，等正文渲染出来，把含查询词的第一处滚到视口中央，
 * 并在角上显示一条“全文搜索：‘查询词’”提示（可关）。没有 `?ft` 时什么也不做、不渲染。
 * `ftq` 只作为文本节点显示，不进 innerHTML。
 * 必须渲染在 `hostRef` 之外，否则提示里的查询词会被当成命中。
 */
const LOCATE_TIMEOUT_MS = 10000;

interface Props {
    hostRef: RefObject<HTMLElement | null>;
    /** 当前章（地址里的章号）；与 ft 的章不一致时不定位 */
    chapter: string | null | undefined;
    /** 默认 window.location.search，测试可传 */
    search?: string;
}

export default function ReaderFulltextHint({ hostRef, chapter, search }: Props) {
    const t = useSiteT();
    // 挂载后再读地址：服务端渲染与首帧水合都是空，避免不一致
    const [ft, setFt] = useState<FtParams | null>(null);
    useEffect(() => { setFt(parseFtParams(search ?? window.location.search)); }, [search]);
    const [shown, setShown] = useState(true);
    const active = !!ft && ft.chapter === (chapter ?? '');

    useEffect(() => {
        const host = hostRef.current;
        if (!active || !ft || !ft.q || !host) return;
        let done = false;
        const tryLocate = () => {
            if (done) return;
            const el = findQueryNode(host, ft.q);
            if (!el) return;
            done = true;
            el.scrollIntoView?.({ block: 'center', behavior: 'auto' });
            mo.disconnect();
        };
        const mo = new MutationObserver(tryLocate);
        mo.observe(host, { childList: true, subtree: true, characterData: true });
        tryLocate();
        const timer = setTimeout(() => { done = true; mo.disconnect(); }, LOCATE_TIMEOUT_MS);
        return () => { done = true; mo.disconnect(); clearTimeout(timer); };
    }, [active, ft, hostRef]);

    if (!active || !ft || !ft.q || !shown) return null;
    return (
        <div role="status" style={{ position: 'fixed', right: 12, bottom: 12, zIndex: 40, padding: '6px 10px', background: 'rgba(255,255,255,.95)', border: '1px solid #ccc', borderRadius: 6, fontSize: 13 }}>
            <span>{t('bookIndex.fulltext.locateHint', { q: ft.q })}</span>
            <button type="button" aria-label={t('bookIndex.fulltext.locateDismiss')} onClick={() => setShown(false)} style={{ marginLeft: 8 }}>×</button>
        </div>
    );
}
