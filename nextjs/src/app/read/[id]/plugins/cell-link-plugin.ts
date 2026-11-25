import { loadReaderFiles, type ReaderPlugin } from 'book-index-ui';
import { TEXT_FILE_BASE } from '@/lib/text-file';
import { collectU, parseCellLink, resolveCellLink, type CellLink, type UIndex } from '@/lib/cell-u';

const ID = 'kyg:cell-link';

export interface CellLinkPluginOpts {
    /** 解析出章内锚点后交给宿主（宿主把它传给阅读器的 anchor，滚过去） */
    onResolve: (anchor: string) => void;
    /** 每章 char 取到后给宿主本章格位↔u 对照（读者点目录标题时地址写 ?u= 用）；不传就只在地址带了深链时才取 char */
    onIndex?: (idx: UIndex, chapterKey: string) => void;
    /** 测试注入：缺省读 window.location.search */
    getSearch?: () => string;
}

/**
 * 深链按字格永久编号 u 定位（guji-char v0.6）：`/read/<书>/<册>?u=<n>`（或 `?u=<n>~<m>`），兼容 `?cell=页:列:格`。
 * 每章取到 char.json 后查 u → 格位，交给宿主当锚点。`?cell=` 不用等 char，直接给。
 * 给了 onIndex 时每章都取 char（与阅读器同一份缓存），把本章格位↔u 对照交给宿主。
 * 只管地址带进来的那一次：同一个请求在同一章解析过就不再给（读者自己滚走后，换版本回来不该又被拽回去）。
 * u 查不到（老文本没有 u、或不是这一册）就不给，地址里的 #格位 兜底。
 */
export function cellLinkPlugin(o: CellLinkPluginOpts): ReaderPlugin {
    const done = new Set<string>();
    const search = () => (o.getSearch ? o.getSearch() : typeof window === 'undefined' ? '' : window.location.search);
    return {
        id: ID,
        async onChapter(ctx) {
            const link: CellLink | null = parseCellLink(search());
            const key = link ? `${ctx.chapterKey}|${JSON.stringify(link)}` : '';
            let want = !!link && !done.has(key);
            if (want && link && 'cell' in link) {            // ?cell= 不用等 char
                done.add(key);
                o.onResolve(link.cell);
                want = false;
            }
            if (!want && !o.onIndex) return undefined;
            const files = await loadReaderFiles(
                ctx.transport as never,
                { id: ctx.entryId, versionKey: ctx.versionKey, chapter: ctx.chapter as unknown as Record<string, unknown> },
                { cord: ctx.viewport === 'wide', textFileBase: TEXT_FILE_BASE },
            );
            const idx = files?.char ? collectU(files.char) : { byA: new Map<string, number>(), byU: new Map<number, string>() };
            o.onIndex?.(idx, ctx.chapterKey);
            if (want && link) {
                const anchor = resolveCellLink(link, idx);
                if (anchor) {
                    done.add(key);
                    o.onResolve(anchor);
                }
            }
            return undefined;
        },
    };
}
