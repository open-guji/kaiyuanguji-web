/**
 * 书影：从 IIIF manifest 取一册的各页影像（COS，数据域名 DATA_ORIGIN；overview#388／#389）。
 *
 * 地址：<base>/iiif/<bookId>/<册>/manifest.json；canvas 的 body 是 Choice，第一项是本站图（阅读档 1200 宽，
 * 来自 Commons／IA 的在后面）；原图宽度那一档（放大档，透视矫正要用）地址同形，只把 `/full/<宽>,/` 换成原图宽。
 *
 * 页码对照：对读数据（cord.json 每页的 `canvas`，`id` 形如 `…/iiif/<书>/canvas/<册2位>/<页序>`）给出每页对应的 IIIF 页序 `seq`
 * （leaf 号零填 4 位，合扫拆页带 a–d 后缀）；册号取自 canvas id（见 book-index-ui 的 `iiifVolumeOf`），阅读器按 `seq` 到本册
 * manifest 的 canvas 里对位取阅读档／原图档。格位 key 的「页」、cord 的 `page`、canvas 的 seq 是同一个数（扫描顺序号，从 1 起）；
 * 合扫拆页已拆成独立页，卷三 105–108 页各对应 0105a–d。第 1 叶是书脊签，对读数据从第 3 叶起。
 *
 * 海外读者（`preferCommons()`）：canvas 带 `bim:commons` 的页改读 Commons 缩略图并在浏览器里摆正（commons-warp.ts），失败退回本站图。
 * TODO（本卡不做）：本站图挂了换 IA 的前端回退链（canvas body Choice 的后几项）。
 */
import type { ReaderPageImage } from 'book-index-ui';
// 页面范围随 book-index-ui ≥0.66.4 的 ReaderPageImage.extent；这里按结构自带一份类型，旧版本的包也能编译（旧包忽略多出的字段）
interface PageExtent {
    src: { url?: string; w: number; h: number };
    H: number[];
    content: [number, number, number, number];
}
import { DATA_ORIGIN } from './hosts';
import { commonsImageUrl, preferCommons, registerCommonsWarp, validCommons } from './commons-warp';

export const FACSIMILE_BASE = process.env.NEXT_PUBLIC_FACSIMILE_BASE || `${DATA_ORIGIN}/iiif`;

interface IiifCanvas {
    id: string;
    label?: Record<string, string[]>;
    width: number;
    height: number;
    /** 海外读者的 Commons 书影（四庫總目文淵閣本）：缩略图地址与「缩略图 → 页图」的透视矩阵，见 ops/iiif/commons_warp.py */
    'bim:commons'?: unknown;
    /** 页面范围（书影页面范围统一规范）：源图、页图→源图矩阵 H（9 个数，行优先）、版框内容区；见 pageExtentOf */
    'bim:page'?: unknown;
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

/**
 * canvas 的 `bim:page` → 阅读器的页面范围。形状不对一律返回 undefined（该页退回页图整幅／运行时检测），不抛错：
 * `{ src: {url?, w, h}, H: 9 个有限数, content: [x, y, w, h]（w、h > 0） }`。
 */
export function pageExtentOf(raw: unknown): PageExtent | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const r = raw as { src?: { url?: unknown; w?: unknown; h?: unknown }; H?: unknown; content?: unknown };
    const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
    const src = r.src;
    if (!src || !finite(src.w) || !finite(src.h) || src.w <= 0 || src.h <= 0) return undefined;
    if (!Array.isArray(r.H) || r.H.length !== 9 || !r.H.every(finite) || Math.abs(r.H[8]) < 1e-9) return undefined;
    const c = r.content;
    if (!Array.isArray(c) || c.length !== 4 || !c.every(finite) || c[2] <= 0 || c[3] <= 0) return undefined;
    const url = typeof src.url === 'string' && /^https:\/\//.test(src.url) ? src.url : undefined;
    // 版心三档的另外两种取景：none（页图坐标）、full（源图坐标，要 src.url 才用）；形状不对的那一项丢掉
    const rect = (v: unknown): [number, number, number, number] | undefined =>
        Array.isArray(v) && v.length === 4 && v.every(finite) && v[2] > 0 && v[3] > 0 ? (v as [number, number, number, number]) : undefined;
    const rv = (r as { views?: { none?: unknown; full?: unknown } }).views;
    const none = rv && typeof rv === 'object' ? rect(rv.none) : undefined;
    const full = rv && typeof rv === 'object' ? rect(rv.full) : undefined;
    return {
        src: { ...(url ? { url } : {}), w: src.w, h: src.h }, H: r.H as number[], content: c as [number, number, number, number],
        ...(none || full ? { views: { ...(none ? { none } : {}), ...(full ? { full } : {}) } } : {}),
    };
}

/** manifest 的 canvas 列表 → 阅读器的书影页。取不到页序的 canvas 跳过 */
export function canvasesToImages(canvases: IiifCanvas[], opts: { commons?: boolean } = {}): ReaderPageImage[] {
    const out: ReaderPageImage[] = [];
    let ext: ReturnType<typeof pageExtentOf>;
    for (const c of canvases) {
        const first = c.items?.[0]?.items?.[0]?.body?.items?.[0];
        const m = /\/(\d{4})([a-z]?)\/full\//.exec(first?.id ?? '');
        if (!first || !m) continue;
        const leaf = parseInt(m[1], 10);
        // 海外读者：有 Commons 摆正矩阵的页改读 Commons 3840 档（半叶约 1615 像素宽），地址带摆正参数，出错退回本站图
        const cm = opts.commons && validCommons(c['bim:commons']) ? c['bim:commons'] : null;
        const commonsUrl = cm ? commonsImageUrl(cm, c.width, c.height, hiresUrlOf(first.id, c.width)) : null;
        out.push({
            url: commonsUrl ?? first.id,
            hiresUrl: commonsUrl ?? hiresUrlOf(first.id, c.width),
            ...(commonsUrl ? { alt: '景印文淵閣四庫全書，Wikimedia Commons' } : {}),
            width: c.width,
            height: c.height,
            ...((ext = pageExtentOf(c['bim:page'])) ? ({ extent: ext } as object) : {}),
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
        const commons = preferCommons();
        if (commons) registerCommonsWarp();
        p = fetch(url)
            .then(r => (r.ok ? r.json() : null))
            .then(m => (m && Array.isArray(m.items) ? canvasesToImages(m.items, { commons }) : null))
            .catch(() => null);
        cache.set(url, p);
        p.then(v => { if (!v) cache.delete(url); });
    }
    return p;
}
