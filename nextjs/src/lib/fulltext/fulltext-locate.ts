/**
 * 阅读页全文搜索定位（GUJI-163 / F6 步 4，第一档：跳章＋近似滚动）。
 *
 * 地址：`/read/<id>/<章>?ft=<章>:<起>-<止>&ftq=<查询词>`。起止是章内 Unicode 码点偏移（见 fulltext-offsets.ts），
 * 第一档不用它做精确高亮，只校验形态；定位靠 `ftq`，由阅读页的全文定位插件经阅读器接口 `api.locate({ text })` 找（不再在 DOM 里找文本节点）。
 * `ftq` 是 URL 反射内容：只许当文本用（文本节点显示、字符串比对），不得进 innerHTML。
 */

export interface FtParams {
    chapter: string;
    start: number;
    end: number;
    q: string;
}

const FT_RE = /^(\d{1,6}):(\d{1,9})-(\d{1,9})$/;
export const FTQ_MAX = 100;

export function parseFtParams(search: string): FtParams | null {
    const p = new URLSearchParams(search);
    const ft = p.get('ft');
    if (!ft) return null;
    const m = FT_RE.exec(ft);
    if (!m) return null;
    const start = Number(m[2]);
    const end = Number(m[3]);
    if (end < start) return null;
    // eslint-disable-next-line no-control-regex
    const q = (p.get('ftq') ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, FTQ_MAX);
    return { chapter: m[1], start, end, q };
}
