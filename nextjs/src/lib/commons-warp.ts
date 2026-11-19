/**
 * 海外读者的书影：改读 Wikimedia Commons 的 DjVu 缩略图（3840 宽），在浏览器里按页表矩阵摆正成本站页图。
 *
 * 为什么摆正：逐字框、高亮都在本站页图坐标里；页图是 A20 按版框从 600dpi DjVu 原图透视摆正裁出的。
 * 矩阵由 ops/iiif/commons_warp.py 算好写进 manifest 的 canvas（`bim:commons.matrix`，缩略图像素 → 页图像素），这里只套用。
 * 缩略图地址是前端直接拼好的 upload.wikimedia.org 静态地址，不走 Commons API（API 对我们限流 429）。
 *
 * 取图地址 = `<缩略图>#bimwarp=<9 个数>&w=<页图宽>&h=<页图高>&fb=<本站图地址>`；片段不会发给服务器，
 * 没有登记取图钩子时它仍是一张能显示的（未摆正的）图。登记见 `registerCommonsWarp()`（book-index-ui 的 setImageSourceResolver）。
 * 冷门页第一次可能慢或被 Wikimedia 429：超时、出错一律退回本站图。
 */
import { setImageSourceResolver } from 'book-index-ui';

export const COMMONS_PREF_KEY = 'og_facsimile_src';
const MAINLAND_TZ = new Set(['Asia/Shanghai', 'Asia/Chongqing', 'Asia/Chungking', 'Asia/Harbin', 'Asia/Urumqi', 'Asia/Kashgar', 'PRC']);
const TIMEOUT_MS = 12000;

export interface CanvasCommons {
    url: string;
    width: number;
    height: number;
    matrix: number[];
}

/** 读者该不该改读 Commons：`?img=commons|own` 或存的偏好优先；否则看时区——大陆时区读本站（国内连 Wikimedia 不稳），其余读 Commons */
export function preferCommons(): boolean {
    if (typeof window === 'undefined') return false;
    try {
        const q = new URLSearchParams(window.location.search).get('img');
        if (q === 'commons' || q === 'own') {
            try { window.localStorage.setItem(COMMONS_PREF_KEY, q); } catch { /* 存不了就只管这次 */ }
            return q === 'commons';
        }
        const saved = window.localStorage.getItem(COMMONS_PREF_KEY);
        if (saved === 'commons' || saved === 'own') return saved === 'commons';
    } catch { /* 读不了偏好，按时区 */ }
    try {
        return !MAINLAND_TZ.has(Intl.DateTimeFormat().resolvedOptions().timeZone);
    } catch {
        return false;
    }
}

/** 国内书影（COS 单版整页，1-bit 无损 WebP）：同一套矩阵／摆正路径，见 ops/iiif/pagemeta.py::bim_cos */
export function validCos(c: unknown): c is CanvasCommons {
    const x = c as CanvasCommons | undefined;
    return !!x && typeof x.url === 'string' && /^https:\/\//.test(x.url)
        && Number.isFinite(x.width) && Number.isFinite(x.height) && x.width > 0 && x.height > 0
        && Array.isArray(x.matrix) && x.matrix.length === 9 && x.matrix.every(Number.isFinite);
}

export function validCommons(c: unknown): c is CanvasCommons {
    const x = c as CanvasCommons | undefined;
    return !!x && typeof x.url === 'string' && /^https:\/\/upload\.wikimedia\.org\//.test(x.url)
        && Array.isArray(x.matrix) && x.matrix.length === 9 && x.matrix.every(Number.isFinite);
}

export function commonsImageUrl(c: CanvasCommons, pageW: number, pageH: number, fallback: string): string {
    return `${c.url}#bimwarp=${c.matrix.join(',')}&w=${pageW}&h=${pageH}&fb=${encodeURIComponent(fallback)}`;
}

export interface WarpSpec { matrix: number[]; w: number; h: number; fb: string; src: string }

export function parseWarpUrl(url: string): WarpSpec | null {
    const i = url.indexOf('#bimwarp=');
    if (i < 0) return null;
    const params = new URLSearchParams(`m=${url.slice(i + '#bimwarp='.length)}`);
    const matrix = (params.get('m') ?? '').split(',').map(Number);
    const w = Number(params.get('w'));
    const h = Number(params.get('h'));
    if (matrix.length !== 9 || !matrix.every(Number.isFinite) || !(w > 0) || !(h > 0)) return null;
    return { matrix, w, h, fb: params.get('fb') ?? '', src: url.slice(0, i) };
}

export function invert3(m: number[]): number[] {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-18) throw new Error('矩阵不可逆');
    return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map(v => v / det);
}

export function applyH(m: number[], x: number, y: number): [number, number] {
    const z = m[6] * x + m[7] * y + m[8];
    return [(m[0] * x + m[1] * y + m[2]) / z, (m[3] * x + m[4] * y + m[5]) / z];
}

type Pt = [number, number];
/** 三点对应的仿射 [a,b,c,d,e,f]（canvas setTransform 的顺序：x' = a·x + c·y + e，y' = b·x + d·y + f），src → dst */
export function affineOf(s: Pt[], d: Pt[]): number[] {
    const det = (s[1][0] - s[0][0]) * (s[2][1] - s[0][1]) - (s[2][0] - s[0][0]) * (s[1][1] - s[0][1]);
    const solve = (v0: number, v1: number, v2: number): [number, number, number] => {
        const p = ((v1 - v0) * (s[2][1] - s[0][1]) - (v2 - v0) * (s[1][1] - s[0][1])) / det;
        const q = ((v2 - v0) * (s[1][0] - s[0][0]) - (v1 - v0) * (s[2][0] - s[0][0])) / det;
        return [p, q, v0 - p * s[0][0] - q * s[0][1]];
    };
    const [a, c, e] = solve(d[0][0], d[1][0], d[2][0]);
    const [b, dd, f] = solve(d[0][1], d[1][1], d[2][1]);
    return [a, b, c, dd, e, f];
}

/** 页图 W×H 切成 nx×ny 格、每格两个三角；每个三角给出页图坐标（dst）和对应的缩略图坐标（src，经矩阵逆） */
export function warpTriangles(matrix: number[], W: number, H: number, nx = 12, ny = 16): { src: Pt[]; dst: Pt[] }[] {
    const inv = invert3(matrix);
    const at = (i: number, j: number): { src: Pt; dst: Pt } => {
        const dst: Pt = [(W * i) / nx, (H * j) / ny];
        return { src: applyH(inv, dst[0], dst[1]), dst };
    };
    const out: { src: Pt[]; dst: Pt[] }[] = [];
    for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
            const p00 = at(i, j), p10 = at(i + 1, j), p01 = at(i, j + 1), p11 = at(i + 1, j + 1);
            for (const t of [[p00, p10, p11], [p00, p11, p01]]) out.push({ src: t.map(p => p.src), dst: t.map(p => p.dst) });
        }
    }
    return out;
}

/**
 * 分格数：透视项很小，格子越密误差越小（约按格数平方下降）。取「每格三角的仿射近似与真透视在格心相差 ≤ 0.4px」的最稀一档，
 * 通常 4×6 就够，比固定 12×16 少画一个数量级的三角（每个三角一次 clip + drawImage，主线程上很贵）。
 */
export function pickGrid(matrix: number[], W: number, H: number): [number, number] {
    let inv: number[];
    try { inv = invert3(matrix); } catch { return [12, 16]; }
    for (const nx of [1, 2, 3, 4, 6, 8, 10]) {
        const ny = Math.max(1, Math.ceil((nx * H) / W));
        let worst = 0;
        const dstAt = (i: number, j: number): Pt => [(W * i) / nx, (H * j) / ny];
        const srcAt = (p: Pt): Pt => applyH(inv, p[0], p[1]);
        for (let j = 0; j < ny; j++) {
            for (let i = 0; i < nx; i++) {
                // 格内第一个三角 (p00,p10,p11) 的重心：仿射近似下的位置 vs 真透视
                const d = [dstAt(i, j), dstAt(i + 1, j), dstAt(i + 1, j + 1)];
                const c: Pt = [(d[0][0] + d[1][0] + d[2][0]) / 3, (d[0][1] + d[1][1] + d[2][1]) / 3];
                const s = d.map(srcAt);
                const sc: Pt = [(s[0][0] + s[1][0] + s[2][0]) / 3, (s[0][1] + s[1][1] + s[2][1]) / 3];
                const back = applyH(matrix, sc[0], sc[1]);   // 仿射近似（src 重心）经真矩阵回到页图
                worst = Math.max(worst, Math.hypot(back[0] - c[0], back[1] - c[1]));
            }
        }
        if (worst <= 0.4) return [nx, ny];
    }
    return [12, 16];
}

/** 把缩略图按矩阵摆到 W×H 的画布上：分格仿射近似透视（版框歪斜只有几度，格够密就看不出），GPU 画，不读像素 */
export function drawWarped(ctx: CanvasRenderingContext2D, img: CanvasImageSource, matrix: number[], W: number, H: number): void {
    ctx.fillStyle = '#f4efe3';
    ctx.fillRect(0, 0, W, H);
    ctx.imageSmoothingQuality = 'high';
    if (Math.abs(matrix[6]) < 1e-12 && Math.abs(matrix[7]) < 1e-12 && Math.abs(matrix[8]) > 1e-12) {
        // 仿射（单页扫描书：恒等或纯缩放）：不必分格，整图一次画完
        const k = matrix[8];
        ctx.save();
        ctx.setTransform(matrix[0] / k, matrix[3] / k, matrix[1] / k, matrix[4] / k, matrix[2] / k, matrix[5] / k);
        ctx.drawImage(img, 0, 0);
        ctx.restore();
        return;
    }
    const [gx, gy] = pickGrid(matrix, W, H);
    for (const t of warpTriangles(matrix, W, H, gx, gy)) {
        const [a, b, c, d, e, f] = affineOf(t.src, t.dst);
        ctx.save();
        // 三角向外扩 0.6px 再裁，相邻三角叠一点，免得缝里透底色
        const cx = (t.dst[0][0] + t.dst[1][0] + t.dst[2][0]) / 3, cy = (t.dst[0][1] + t.dst[1][1] + t.dst[2][1]) / 3;
        ctx.beginPath();
        t.dst.forEach(([x, y], k) => {
            const dx = x - cx, dy = y - cy, L = Math.hypot(dx, dy) || 1;
            const px = x + (dx / L) * 0.6, py = y + (dy / L) * 0.6;
            if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        });
        ctx.closePath();
        ctx.clip();
        ctx.setTransform(a, b, c, d, e, f);
        // 只画三角在缩略图里的外接框（整图画 384 次太费）
        const xs = t.src.map(p => p[0]), ys = t.src.map(p => p[1]);
        const sx = Math.floor(Math.min(...xs)) - 1, sy = Math.floor(Math.min(...ys)) - 1;
        const sw = Math.ceil(Math.max(...xs)) + 1 - sx, sh = Math.ceil(Math.max(...ys)) + 1 - sy;
        ctx.drawImage(img, sx, sy, sw, sh, sx, sy, sw, sh);
        ctx.restore();
    }
}

function plainImage(url: string): Promise<HTMLImageElement | null> {
    return new Promise(resolve => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = url;
    });
}

/** 缩略图按矩阵摆正成页图，返回 blob 地址（调用方负责 revoke）；失败 null */
async function warpToObjectUrl(spec: WarpSpec): Promise<string | null> {
    const img = await plainImage(spec.src);
    if (!img) return null;
    const canvas = document.createElement('canvas');
    canvas.width = spec.w;
    canvas.height = spec.h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    drawWarped(ctx, img, spec.matrix, spec.w, spec.h);
    const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/jpeg', 0.92));
    return blob ? URL.createObjectURL(blob) : null;
}

const resolverCache = new Map<string, Promise<HTMLImageElement | null>>();
const RESOLVER_CACHE_MAX = 24;

/**
 * 取图钩子：认得 `#bimwarp=` 地址的就摆正；失败、超时退回本站图（fb）。别的地址返回 null，走默认加载。
 * 同一地址的结果缓存（最近 24 张）：阅读页滚动时页面反复挂载／卸载，每次都重新解码 3840 宽整页、分格摆正、编码再解码，
 * 主线程上一页就是上百毫秒；缓存后重新挂载直接复用同一个 img（阅读器按 img 缓存的版框检测也跟着命中）。
 */
export function commonsResolver(url: string): Promise<HTMLImageElement | null> | null {
    const spec = parseWarpUrl(url);
    if (!spec) return null;
    const hit = resolverCache.get(url);
    if (hit) {
        resolverCache.delete(url);
        resolverCache.set(url, hit);   // 最近使用排到最后
        return hit;
    }
    const fallback = () => (spec.fb ? plainImage(spec.fb) : Promise.resolve(null));
    const work = (async () => {
        const obj = await warpToObjectUrl(spec);
        if (!obj) return null;
        const out = await plainImage(obj);
        URL.revokeObjectURL(obj);
        return out;
    })().catch(() => null);
    const timeout = new Promise<null>(r => setTimeout(() => r(null), TIMEOUT_MS));
    const p = Promise.race([work, timeout]).then(r => r ?? fallback());
    resolverCache.set(url, p);
    p.then(v => { if (!v) resolverCache.delete(url); });   // 失败不缓存
    while (resolverCache.size > RESOLVER_CACHE_MAX) resolverCache.delete(resolverCache.keys().next().value as string);
    return p;
}

const displayCache = new Map<string, Promise<string>>();

/**
 * 给普通 `<img>` 用的地址（校对页整页书影等不走 book-index-ui 的地方）：`#bimwarp=` 地址摆正成 blob 地址，
 * 失败、超时退回本站图；别的地址原样返回。同一地址只摆正一次。
 */
export function displayImageUrl(url: string): Promise<string> {
    const spec = parseWarpUrl(url);
    if (!spec) return Promise.resolve(url);
    let p = displayCache.get(url);
    if (!p) {
        const work = warpToObjectUrl(spec).catch(() => null);
        const timeout = new Promise<null>(r => setTimeout(() => r(null), TIMEOUT_MS));
        p = Promise.race([work, timeout]).then(r => r ?? spec.fb ?? spec.src);
        displayCache.set(url, p);
    }
    return p;
}

let registered = false;
export function registerCommonsWarp(): void {
    if (registered || typeof window === 'undefined') return;
    registered = true;
    setImageSourceResolver(commonsResolver);
}
