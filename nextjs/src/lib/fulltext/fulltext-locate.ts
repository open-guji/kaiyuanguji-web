/**
 * 阅读页全文搜索定位（GUJI-163 / F6 步 4，第一档：跳章＋近似滚动）。
 *
 * 地址：`/read/<id>/<章>?ft=<章>:<起>-<止>&ftq=<查询词>`。起止是章内 Unicode 码点偏移（见 fulltext-offsets.ts），
 * 第一档不用它做精确高亮，只校验形态；定位靠 `ftq` 在已渲染 DOM 里找文本。
 * `ftq` 是 URL 反射内容：只许当文本用（文本节点显示、textContent 比对），不得进 innerHTML。
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

/** 在 root 的文本里找 q 首次出现的位置，返回其起点所在元素；找不到返回 null。纯 textContent 比对。 */
export function findQueryNode(root: HTMLElement, q: string): HTMLElement | null {
    if (!q) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    let full = '';
    const starts: number[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        starts.push(full.length);
        nodes.push(n as Text);
        full += (n as Text).data;
    }
    const idx = full.indexOf(q);
    if (idx < 0) return null;
    let lo = 0;
    for (let i = 0; i < starts.length; i += 1) if (starts[i] <= idx) lo = i;
    return nodes[lo].parentElement;
}
