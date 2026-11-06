import { useEffect, useState } from 'react';
import type { ReaderApi, ReaderPlugin } from 'book-index-ui';
import { parseFtParams, type FtParams } from '@/lib/fulltext/fulltext-locate';
import { useSiteT } from '@/i18n/use-site-t';

const ID = 'kyg:fulltext';

/**
 * 阅读页的全文搜索定位（GUJI-163 / F6 步 4，第一档）：地址带 `?ft=<章>:<起>-<止>&ftq=` 且章号与当前章一致时，
 * 等正文出来，把含查询词的第一处滚到视口中央，并在角上显示一条“全文搜索：‘查询词’”提示（可关）。没有 `?ft` 时不渲染。
 * 定位走阅读器接口 `api.locate({ text })` + `api.scrollTo`，不再遍历文本节点；`ftq` 只作为文本显示，不进 innerHTML。
 * （阅读器的 locate 只认有逐字格位的对读章；整理本／Markdown 章没有格位，这几章只显示提示、不滚动。）
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
    const hasCells = api.cells.length > 0;

    // 格出来（换章、加载完）就定位一次；同一个 ft 只滚一次
    const [done, setDone] = useState<string | null>(null);
    const once = ft ? `${ft.chapter}:${ft.start}:${ft.q}` : null;
    useEffect(() => {
        if (!active || !ft || !ft.q || !hasCells || done === once) return;
        const anchor = api.locate({ text: ft.q });
        if (anchor) { api.scrollTo(anchor, { block: 'center' }); setDone(once); }
    }, [active, ft, hasCells, api, done, once]);

    if (!active || !ft || !ft.q || !shown) return null;
    return (
        <div role="status" style={{ padding: '6px 10px', background: 'rgba(255,255,255,.95)', border: '1px solid #ccc', borderRadius: 6, fontSize: 13 }}>
            <span>{t('bookIndex.fulltext.locateHint', { q: ft.q })}</span>
            <button type="button" aria-label={t('bookIndex.fulltext.locateDismiss')} onClick={() => setShown(false)} style={{ marginLeft: 8 }}>×</button>
        </div>
    );
}
