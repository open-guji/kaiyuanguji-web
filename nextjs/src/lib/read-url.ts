/**
 * 阅读页地址约定（N3b 与 N5b 共用，overview#212）：
 *
 *   /item/<id>/read?kind=collated|fulltext[&key=<fullTextKey>][&juan=<卷>]
 *
 * - kind=collated：Work 的整理本；kind=fulltext：Work 或 Book 的全文。
 * - key：Work 全文有多份时指定哪一份（book-index-ui 的 fullTextKey）。
 * - juan：直接打开某一卷／章（整理本卷文件名或全文章节 stem）。
 */
export type ReadKind = 'collated' | 'fulltext';

export interface ReadUrlOptions {
    kind: ReadKind;
    key?: string | null;
    juan?: string | null;
}

export function buildReadUrl(id: string, { kind, key, juan }: ReadUrlOptions): string {
    const p = new URLSearchParams({ kind });
    // key 只对全文有意义；整理本带上它只会多出一个非规范地址（N5b 的 readerHref 同样丢掉）
    if (key && kind === 'fulltext') p.set('key', key);
    if (juan) p.set('juan', juan);
    return `/item/${encodeURIComponent(id)}/read?${p.toString()}`;
}
