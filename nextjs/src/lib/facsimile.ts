/**
 * 书影：从 IIIF manifest 取一册的各页影像（COS，data.kaiyuanguji.com；overview#388／#389）。
 *
 * 地址：<base>/iiif/<bookId>/<册>/manifest.json；canvas 的 body 是 Choice，第一项是本站图（阅读档 1200 宽，
 * 来自 Commons／IA 的在后面）；原图宽度那一档（放大档，透视矫正要用）地址同形，只把 `/full/<宽>,/` 换成原图宽。
 *
 * 页码对照：对读数据（cord.json 每页的 `canvas`，`id` 形如 `…/iiif/<书>/canvas/<册2位>/<页序>`）给出每页对应的 IIIF 页序 `seq`
 * （leaf 号零填 4 位，合扫拆页带 a–d 后缀）；册号取自 canvas id（见 book-index-ui 的 `iiifVolumeOf`），阅读器按 `seq` 到本册
 * manifest 的 canvas 里对位取阅读档／原图档。格位 key 的「页」、cord 的 `page`、canvas 的 seq 是同一个数（扫描顺序号，从 1 起）；
 * 合扫拆页已拆成独立页，卷三 105–108 页各对应 0105a–d。第 1 叶是书脊签，对读数据从第 3 叶起。
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
        const m = /\/(\d{4})([a-z]?)\/full\//.exec(first?.id ?? '');
        if (!first || !m) continue;
        const leaf = parseInt(m[1], 10);
        out.push({
            url: first.id,
            hiresUrl: hiresUrlOf(first.id, c.width),
            width: c.width,
            height: c.height,
            seq: m[1] + m[2],
            // 拆页（合扫叶拆成 a–d）的页号与 leaf 号不对应，不给 pageNo，对读按 seq 对位
            ...(m[2] ? {} : { pageNo: leaf }),
            label: m[2] ? `第 ${leaf}${m[2]} 葉` : `第 ${leaf} 葉`,
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
