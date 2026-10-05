/**
 * 书影：从 IIIF manifest 取一册的各页影像（COS，data.kaiyuanguji.com；overview#388／#389）。
 *
 * 地址：<base>/iiif/<bookId>/<册>/manifest.json；canvas 的 body 是 Choice，第一项是本站图（阅读档 1200 宽，
 * 来自 Commons／IA 的在后面）；原图宽度那一档（放大档，透视矫正要用）地址同形，只把 `/full/<宽>,/` 换成原图宽。
 *
 * 页码对照（2026-10-05 抽 3、100、188 三叶对图核过）：对读数据（pages.json、lines.md、逐字 id `<页>:<列>:<格>`）
 * 里的「页」就是 IA 的 leaf 号，即 canvas 的 `<页序>`（零填 4 位）——第 N 页 ＝ 第 N 个 canvas。
 * 第 1 叶是书脊签，对读数据从第 3 叶起。
 *
 * TODO（本卡不做）：图挂了换 Commons／IA 的前端回退链（canvas body Choice 的后几项）。
 */
import type { ReaderPageImage } from 'book-index-ui';

export const FACSIMILE_BASE = process.env.NEXT_PUBLIC_FACSIMILE_BASE || 'https://data.kaiyuanguji.com/iiif';

interface IiifCanvas {
    id: string;
    label?: Record<string, string[]>;
    width: number;
    height: number;
    items?: { items?: { body?: { items?: { id: string; width?: number; height?: number }[] } }[] }[];
}

/** 页序（leaf 号）→ 页序段，如 3 → '0003' */
export function leafSegment(page: number): string {
    return String(page).padStart(4, '0');
}

/** 原图宽度一档的地址：把阅读档 `/full/<宽>,/` 换成原图宽 */
export function hiresUrlOf(readingUrl: string, fullWidth: number): string {
    return readingUrl.replace(/\/full\/\d+,\//, `/full/${fullWidth},/`);
}

/** manifest 的 canvas 列表 → 阅读器的书影页。取不到页序的 canvas 跳过 */
export function canvasesToImages(canvases: IiifCanvas[]): ReaderPageImage[] {
    const out: ReaderPageImage[] = [];
    for (const c of canvases) {
        const first = c.items?.[0]?.items?.[0]?.body?.items?.[0];
        const m = /\/(\d+)\/full\//.exec(first?.id ?? '');
        if (!first || !m) continue;
        const pageNo = parseInt(m[1], 10);
        out.push({
            url: first.id,
            hiresUrl: hiresUrlOf(first.id, c.width),
            width: c.width,
            height: c.height,
            pageNo,
            label: `第 ${pageNo} 葉`,
        });
    }
    return out;
}

const cache = new Map<string, Promise<ReaderPageImage[] | null>>();

/** 取一册的书影页；失败返回 null（不缓存失败） */
export function loadFacsimile(bookId: string, vol: string): Promise<ReaderPageImage[] | null> {
    const url = `${FACSIMILE_BASE}/${bookId}/${vol}/manifest.json`;
    let p = cache.get(url);
    if (!p) {
        p = fetch(url)
            .then(r => (r.ok ? r.json() : null))
            .then(m => (m && Array.isArray(m.items) ? canvasesToImages(m.items) : null))
            .catch(() => null);
        cache.set(url, p);
        p.then(v => { if (!v) cache.delete(url); });
    }
    return p;
}
