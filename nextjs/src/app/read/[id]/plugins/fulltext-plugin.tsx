import { useEffect, useRef, useState } from 'react';
import type { ReaderApi, ReaderPlugin } from 'book-index-ui';
import { parseFtParams, type FtParams } from '@/lib/fulltext/fulltext-locate';
import { useSiteT } from '@/i18n/use-site-t';

const ID = 'kyg:fulltext';
const LOCATE_TIMEOUT_MS = 10000;

/**
 * 阅读页的全文搜索定位（GUJI-163 / F6 步 4，第一档）：地址带 `?ft=<章>:<起>-<止>&ftq=` 且章号与当前章一致时，
 * 等正文出来，把含查询词的第一处滚到视口中央，并在角上显示一条“全文搜索：‘查询词’”提示（可关）。没有 `?ft` 时不渲染。
 * 定位走阅读器接口 `api.locate({ text })` + `api.scrollTo`，不再遍历文本节点；`ftq` 只作为文本显示，不进 innerHTML。
 * （有逐字格位的章按格位找，整理本／Markdown 章由阅读器按渲染出的文字找，返回不透明记号，直接交给 scrollTo。）
 */
export const fulltextPlugin: ReaderPlugin = {
    id: ID,
    overlay: (api) => <FulltextHint api={api} />,
};

function FulltextHint({ api, search }: { api: ReaderApi; search?: string }) {
    const t = useSiteT();
    // 挂载后再读地址：服务端渲染与首帧水合都是空，避免不一致
    const [ft, setFt] = useState<FtParams | null>(null);
    useEffect(() => { setFt(parseFtParams(search ?? window.location.search)); }, [search]);
    const [shown, setShown] = useState(true);
    const chapter = api.ctx.chapterKey.replace(/\.[^.]+$/, '');
    const active = !!ft && ft.chapter === chapter;

    // 正文渲染出来才找得到（对读章等格位出来，整理本／Markdown 等等文字渲染出来）：每 300ms 试一次，最多 10 秒；同一个 ft 只滚一次
    const apiRef = useRef(api);
    apiRef.current = api;
    const [done, setDone] = useState<string | null>(null);
    const once = ft ? `${ft.chapter}:${ft.start}:${ft.q}` : null;
    useEffect(() => {
        if (!active || !ft || !ft.q || done === once) return;
        let stop = false;
        const started = Date.now();
        const tick = () => {
            if (stop) return;
            const a = apiRef.current;
            const mark = a.locate({ text: ft.q });
            if (mark) { a.scrollTo(mark, { block: 'center' }); setDone(once); return; }
            if (Date.now() - started < LOCATE_TIMEOUT_MS) timer = setTimeout(tick, 300);
        };
        let timer: ReturnType<typeof setTimeout> | undefined;
        tick();
        return () => { stop = true; clearTimeout(timer); };
    }, [active, ft, done, once]);

    if (!active || !ft || !ft.q || !shown) return null;
    return (
        <div role="status" style={{ padding: '6px 10px', background: 'rgba(255,255,255,.95)', border: '1px solid #ccc', borderRadius: 6, fontSize: 13 }}>
            <span>{t('bookIndex.fulltext.locateHint', { q: ft.q })}</span>
            <button type="button" aria-label={t('bookIndex.fulltext.locateDismiss')} onClick={() => setShown(false)} style={{ marginLeft: 8 }}>×</button>
        </div>
    );
}
