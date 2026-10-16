/**
 * 精校页（GUJI-551）的数据与提交逻辑：不依赖 React，页面组件只管渲染。
 *
 * 数据：
 *   - `pending.json`（册级，`guji-pending/0.1`）：只含待审格，声明在该册章条目的 `pending_file`；
 *     候选 `cand` 直接用 lib/proof.ts 的 parseProof（547），不另写解析。
 *   - 像素框：先用 pending 里的可选 `box`（[x,y,w,h]，原叶图 canvas、左上原点），没有就按格号 `a` 去
 *     章条目 `cord_file` 的 `pages[].cells[].box`（同为 xywh）里查；都没有只显示字，不裁图。
 *   - 原叶图：IIIF 放大档（原宽无损 WebP），地址见 lib/facsimile.ts；页序取 cord `pages[].canvas.seq`。
 * 本模块只读、不抛：缺失、坏 JSON、字段未知都返回空/null，页面照常。
 */
import { parseProof, type ProofCandidate } from '@/lib/proof';

export type Box = [number, number, number, number];

export interface PendingCell {
    a: string;
    /** 机器当前读的字 */
    c?: string;
    cand?: ProofCandidate[];
    box?: Box;
}

export interface PendingData {
    /** 提交时必须原样带回；缺失／非法时为 null（页面不放提交） */
    rev: string | null;
    cells: PendingCell[];
}

const RE_REV = /^[A-Za-z0-9._-]{1,64}$/;

const isBox = (v: unknown): v is Box =>
    Array.isArray(v) && v.length === 4 && v.every(n => typeof n === 'number' && Number.isFinite(n)) && v[2] > 0 && v[3] > 0;

const asObject = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** pending.json → 待审格列表（已校过的 `human` 不要）。坏数据不抛 */
export function parsePending(raw: unknown): PendingData {
    const o = asObject(raw);
    const rev = typeof o?.rev === 'string' && RE_REV.test(o.rev) ? o.rev : null;
    const list = Array.isArray(raw) ? raw : o?.cells;
    const boxes = new Map<string, Box>();
    for (const item of Array.isArray(list) ? list : []) {
        const it = asObject(item);
        if (it && typeof it.a === 'string' && isBox(it.box)) boxes.set(it.a, it.box);
    }
    const cells: PendingCell[] = [];
    for (const cell of parseProof(raw).cells.values()) {
        if (cell.review === 'human') continue;
        const box = boxes.get(cell.a);
        cells.push({ a: cell.a, ...(cell.c ? { c: cell.c } : {}), ...(cell.cand ? { cand: cell.cand } : {}), ...(box ? { box } : {}) });
    }
    return { rev, cells };
}

export interface CordIndex {
    boxes: Map<string, Box>;
    /** 页序 → IIIF 页序与 canvas 宽（坐标系的宽，用来换算原图缩放） */
    pages: Map<number, { seq: string; width: number }>;
}

/** cord.json（guji-cord）→ 格位到框、页到 IIIF 页序。坏数据不抛 */
export function parseCord(raw: unknown): CordIndex {
    const out: CordIndex = { boxes: new Map(), pages: new Map() };
    const pages = asObject(raw)?.pages;
    for (const p of Array.isArray(pages) ? pages : []) {
        const po = asObject(p);
        if (!po) continue;
        const page = Number(po.page);
        const canvas = asObject(po.canvas);
        const seq = canvas?.seq;
        if (Number.isInteger(page) && (typeof seq === 'string' || typeof seq === 'number') && String(seq) !== '') {
            const width = Number(canvas?.width ?? asObject(po.image)?.width);
            out.pages.set(page, { seq: String(seq), width: Number.isFinite(width) && width > 0 ? width : 0 });
        }
        for (const c of Array.isArray(po.cells) ? po.cells : []) {
            const co = asObject(c);
            if (co && typeof co.a === 'string' && isBox(co.box)) out.boxes.set(co.a, co.box);
        }
    }
    return out;
}

export interface CellCrop {
    box: Box;
    /** IIIF 页序，用来在册的书影里找原叶图 */
    seq: string;
    /** box 所在坐标系的页宽（canvas 宽）；0＝不知道，按原图宽与 canvas 同比例 */
    canvasWidth: number;
}

/** 这一格能不能裁图：pending 的 box 优先，其次 cord；页序只能来自 cord，缺了就不裁 */
export function resolveCrop(cell: PendingCell, cord: CordIndex | null): CellCrop | null {
    if (!cord) return null;
    const box = cell.box ?? cord.boxes.get(cell.a);
    const page = cord.pages.get(Number(cell.a.split(':')[0]));
    if (!box || !page) return null;
    return { box, seq: page.seq, canvasWidth: page.width };
}

/** 裁剪源矩形（原图像素）。natW 是实际加载到的原叶图宽；四周留 pad 比例的边，夹在图内 */
export function cropRect(crop: CellCrop, natW: number, natH: number, pad = 0.35): [number, number, number, number] {
    const k = crop.canvasWidth > 0 ? natW / crop.canvasWidth : 1;
    const [x, y, w, h] = crop.box.map(n => n * k) as Box;
    const px = w * pad;
    const py = h * pad;
    const x0 = Math.max(0, x - px);
    const y0 = Math.max(0, y - py);
    const x1 = Math.min(natW, x + w + px);
    const y1 = Math.min(natH, y + h + py);
    return [x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)];
}

// ---- 找到该册的待审章 ----

const asRecord = (v: unknown): Record<string, unknown> | null => asObject(v);

/** 版本：声明了 `proofing: true` 的优先，其次 key 为 `original`。字段名未最终定（Mavis P0-1），只在这一处读 */
export function pickProofingVersion(manifest: unknown): string | null {
    const versions = asRecord(manifest)?.versions;
    const list = (Array.isArray(versions) ? versions : []).map(asRecord).filter((v): v is Record<string, unknown> => !!v && typeof v.key === 'string');
    const flagged = list.find(v => v.proofing === true);
    if (flagged) return flagged.key as string;
    return list.find(v => v.key === 'original')?.key as string | undefined ?? null;
}

/** 章：声明了 `pending_file` 的里，按 vol／key／id／文件名主干对上 `vol`；只有一个时就是它 */
export function pickProofingChapter(index: unknown, vol: string): Record<string, unknown> | null {
    const chapters = asRecord(index)?.chapters;
    const cands = (Array.isArray(chapters) ? chapters : [])
        .map(asRecord)
        .filter((c): c is Record<string, unknown> => !!c && typeof c.pending_file === 'string');
    const stem = (v: unknown) => (typeof v === 'string' ? v.replace(/\.[^.]+$/, '') : '');
    const hit = cands.find(c => c.vol === vol || c.key === vol || c.id === vol || stem(c.file) === vol || stem(c.pending_file) === vol);
    return hit ?? (cands.length === 1 ? cands[0] : null);
}

export interface ProofingDeps {
    getManifest: (id: string) => Promise<unknown>;
    getIndex: (id: string, key: string) => Promise<unknown>;
    getFile: (id: string, key: string, file: string) => Promise<unknown>;
}

export type ProofingLoad =
    | { status: 'ok'; pending: PendingData; cord: CordIndex | null; cordRaw: unknown; versionKey: string }
    | { status: 'none' | 'error' };

const SAFE_FILE = /^[\w.-]+$/;

/** 取待审单与（若有）cord。没有该册、没声明、取不到都不抛，回 status */
export async function loadProofing(deps: ProofingDeps, book: string, vol: string): Promise<ProofingLoad> {
    try {
        const versionKey = pickProofingVersion(await deps.getManifest(book));
        if (!versionKey) return { status: 'none' };
        const chapter = pickProofingChapter(await deps.getIndex(book, versionKey), vol);
        const pendingFile = chapter?.pending_file;
        if (!chapter || typeof pendingFile !== 'string' || !SAFE_FILE.test(pendingFile)) return { status: 'none' };
        const cordFile = typeof chapter.cord_file === 'string' && SAFE_FILE.test(chapter.cord_file) ? chapter.cord_file : null;
        const [pendingRaw, cordRaw] = await Promise.all([
            deps.getFile(book, versionKey, pendingFile),
            cordFile ? deps.getFile(book, versionKey, cordFile).catch(() => null) : null,
        ]);
        if (!pendingRaw) return { status: 'error' };
        return { status: 'ok', pending: parsePending(pendingRaw), cord: cordRaw ? parseCord(cordRaw) : null, cordRaw: cordRaw ?? null, versionKey };
    } catch {
        return { status: 'error' };
    }
}

// ---- 提交 ----

export const CELLREVIEW_API = '/api/cellreview';

export type ReviewChoice = 'char' | 'none' | 'unsure' | 'cut' | 'jiazhu';

export interface ReviewDraft {
    book: string;
    vol: string;
    a: string;
    rev: string;
    choice: ReviewChoice;
    char?: string;
    note?: string;
    /** 提交时页面显示的机器读字 */
    shown?: string;
}

/** 提交一条意见；失败返回错误文案，成功返回 null。不抛 */
export async function submitReview(draft: ReviewDraft, aid: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
    try {
        const res = await fetchImpl(CELLREVIEW_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...draft, aid }),
        });
        let body: { success?: boolean; error?: string } | null = null;
        try { body = await res.json(); } catch { /* 非 JSON：按状态码给文案 */ }
        if (res.ok && body?.success !== false) return null;
        if (res.status === 429) return '提交太频繁，请稍后再试';
        return body?.error || `提交失败（${res.status}）`;
    } catch {
        return '网络出错，请稍后再试';
    }
}

// ---- 本地记录（localStorage，读写都包 try/catch，没有也能用）----

const AID_KEY = 'kyg-cr-aid';
const DONE_KEY = (rev: string) => `kyg-cr-done:${rev}`;

function newAid(): string {
    try {
        const u = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : '';
        if (u) return u.replace(/-/g, '');
    } catch { /* 落到下面 */ }
    return Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
}

/** 客户端随机 id：只用来让同一人对同一格的重复提交覆盖旧票；存不了就每次页面加载换一个 */
let memoryAid: string | null = null;
export function getAid(): string {
    try {
        const cur = localStorage.getItem(AID_KEY);
        if (cur && /^[A-Za-z0-9_-]{8,64}$/.test(cur)) return cur;
        const fresh = newAid();
        localStorage.setItem(AID_KEY, fresh);
        return fresh;
    } catch {
        return (memoryAid ??= newAid());
    }
}

export type DoneMap = Record<string, string>;

export function readDone(rev: string): DoneMap {
    try {
        const raw = localStorage.getItem(DONE_KEY(rev));
        const o = raw ? JSON.parse(raw) : null;
        return o && typeof o === 'object' && !Array.isArray(o) ? (o as DoneMap) : {};
    } catch {
        return {};
    }
}

export function writeDone(rev: string, done: DoneMap): void {
    try { localStorage.setItem(DONE_KEY(rev), JSON.stringify(done)); } catch { /* 存不了就算了 */ }
}
