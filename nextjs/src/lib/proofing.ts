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
import { adaptCharCord } from 'book-index-ui';
import { parseProof, type ProofCandidate } from '@/lib/proof';

export type Box = [number, number, number, number];

/** 雪碧图里的一块：`s` 是同目录文件名，x,y,w,h 是它在雪碧图里的像素框 */
export interface SpriteRef { s: string; x: number; y: number; w: number; h: number }

/** guji-proof/0.2 新增字段，全部可选；0.1 的 pending.json 一个都没有 */
export interface PendingExtras {
    why?: string[];
    cls?: string;
    /** 类别细项（目前只有对齐改字层：grid / tail / manual） */
    clsSub?: string;
    libTop?: { c: string; s: number }[];
    lib?: { verdict?: string; cov?: number; wmax?: number };
    ctx?: { c: string; margin?: number; src?: string };
    ref?: { c: string; op?: string };
    ocr?: { c: string; src?: string }[];
    stale?: { c: string; ts?: string; state?: string };
    occ?: { c?: string; refBlank?: boolean };
    img?: SpriteRef;
    ex?: Record<string, SpriteRef[]>;
}

export interface PendingCell extends PendingExtras {
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

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const SPRITE_FILE = /^[\w.-]+$/;

export function parseSprite(v: unknown): SpriteRef | null {
    const o = asObject(v);
    if (!o || typeof o.s !== 'string' || !SPRITE_FILE.test(o.s)) return null;
    const [x, y, w, h] = [o.x, o.y, o.w, o.h].map(num);
    if (x === undefined || y === undefined || w === undefined || h === undefined || x < 0 || y < 0 || w <= 0 || h <= 0) return null;
    return { s: o.s, x, y, w, h };
}

/** 单格的 0.2 新字段。每个键独立容错：类型不对就当没有，不影响其他键 */
export function parseExtras(raw: unknown): PendingExtras {
    const it = asObject(raw);
    const out: PendingExtras = {};
    if (!it) return out;
    if (Array.isArray(it.why)) {
        const why = it.why.filter((x): x is string => typeof x === 'string' && x !== '');
        if (why.length) out.why = why;
    }
    if (str(it.cls)) out.cls = str(it.cls);
    if (str(it.cls_sub)) out.clsSub = str(it.cls_sub);
    if (Array.isArray(it.lib_top)) {
        const libTop = it.lib_top.slice(0, 5).flatMap(x => {
            const o = asObject(x);
            const s = num(o?.s);
            return o && typeof o.c === 'string' && o.c && s !== undefined ? [{ c: o.c, s }] : [];
        });
        if (libTop.length) out.libTop = libTop;
    }
    const lib = asObject(it.lib);
    if (lib) out.lib = { ...(str(lib.verdict) ? { verdict: str(lib.verdict) } : {}), ...(num(lib.cov) !== undefined ? { cov: num(lib.cov) } : {}), ...(num(lib.wmax) !== undefined ? { wmax: num(lib.wmax) } : {}) };
    const ctx = asObject(it.ctx);
    if (ctx && str(ctx.c)) out.ctx = { c: ctx.c as string, ...(num(ctx.margin) !== undefined ? { margin: num(ctx.margin) } : {}), ...(str(ctx.src) ? { src: str(ctx.src) } : {}) };
    const ref = asObject(it.ref);
    if (ref && str(ref.c)) out.ref = { c: ref.c as string, ...(str(ref.op) ? { op: str(ref.op) } : {}) };
    if (Array.isArray(it.ocr)) {
        const ocr = it.ocr.flatMap(x => {
            const o = asObject(x);
            return o && str(o.c) ? [{ c: o.c as string, ...(str(o.src) ? { src: str(o.src) } : {}) }] : [];
        });
        if (ocr.length) out.ocr = ocr;
    }
    const stale = asObject(it.stale);
    if (stale && str(stale.c)) out.stale = { c: stale.c as string, ...(str(stale.ts) ? { ts: str(stale.ts) } : {}), ...(str(stale.state) ? { state: str(stale.state) } : {}) };
    const occ = asObject(it.occ);
    if (occ) out.occ = { ...(str(occ.c) ? { c: str(occ.c) } : {}), ...(typeof occ.ref_blank === 'boolean' ? { refBlank: occ.ref_blank } : {}) };
    const img = parseSprite(it.img);
    if (img) out.img = img;
    const exRaw = asObject(it.ex);
    if (exRaw) {
        const ex: Record<string, SpriteRef[]> = {};
        for (const [k, v] of Object.entries(exRaw)) {
            const list = (Array.isArray(v) ? v : []).slice(0, 5).map(parseSprite).filter((x): x is SpriteRef => !!x);
            if (list.length) ex[k] = list;
        }
        if (Object.keys(ex).length) out.ex = ex;
    }
    return out;
}

/** `why` 机器码 → 给读者看的大白话（码表正本在 cv `review/cards.py`、控制台 `doubt.ts`）。不写术语、缩写、英文；未知码原样显示 */
const WHY_LABELS: Record<string, string> = {
    none: '机器没把握，需要人看一眼',
    near_form: '有长得很像的字，容易认错',
    solo_confusable: '只能靠字形判断，而它有长得很像的字',
    ctx_garble_shape: '字形和本书别处的字都不太像',
    replace_align: '整理本这一段改过字，和刻本可能对不上',
    replace_form: '本书刻的写法和整理本用的字不一样',
    variant_indirect: '可能是异体字，要确认本书刻的是哪个',
    ref_lib_variant: '可能是整理本用字的异体',
    channel_off: '这类情况本书不让机器自动定字',
    form_open: '知道是哪个字，但不确定本书刻的是哪种写法',
    context_vs_ref: '从前后文推断的字和整理本不一样',
    context_verdict: '从前后文推断的结果不寻常',
    iron_vs_ref: '字形很确定，但和整理本不一样',
    iron_ex_missing: '缺少可对照的字样图',
    context_blank_cell: '这一格可能是空白',
    ji_yi_si_review: '己、已、巳刻得一样，要看文意',
    signal_conflict: '几种判断互相矛盾',
    weak_single: '只有一种判断，而且把握不大',
    degraded_crop: '这一格的图不完整',
    db_inconsistent: '和本书别处的认定不一致',
    approx_exemplar: '本书别处对应的字只是近似写法',
    occluded: '被印章或污渍遮住',
};
export const whyLabel = (code: string): string => WHY_LABELS[code] ?? code;

/** 卡片类别（cv `review/cards.py::REVIEW_CLASSES`）→ [名称, 说明]，都用大白话 */
const CLASS_LABELS: Record<string, [string, string]> = {
    occluded: ['有遮挡', '被印章或污渍遮住，一般按整理本的字'],
    ji_yi_si: ['己已巳', '己、已、巳三个字刻得一样，要按文意选'],
    form_open: ['写法待定', '知道是哪个字，但不确定本书刻的是哪种写法'],
    ref_conflict: ['和整理本不一致', '机器的判断和整理本这里的字不一样'],
    near_form: ['形近字', '有长得很像的字，要结合前后文看'],
    lib_miss: ['少见的字', '本书别处没出现过像它的字，可能是生僻字，也可能是切字切坏了'],
    variant: ['异体字', '可能是异体字，要确认本书刻的是哪个'],
    replace_align: ['整理本改过字', '整理本这一段改过字，位置可能差一两格'],
    other: ['把握不足', '机器的几种判断都不够有把握'],
};
export function classLabel(cls: string): { name: string; hint?: string } {
    const hit = CLASS_LABELS[cls];
    return hit ? { name: hit[0], hint: hit[1] } : { name: cls };
}

/** 整理本对位方式 */
const REF_OP_LABELS: Record<string, string> = {
    replace: '整理本这一段改过字，位置可能差一两格',
};
export const refOpLabel = (v: string): string => REF_OP_LABELS[v] ?? '';

/** 要显示的候选：`cand` 与 `lib_top` 前 3 的并集（cand 在前），带库分数；超过 limit 的放「更多」 */
export interface ShownCand { c: string; src?: string[]; score?: number }
export function shownCandidates(cell: PendingCell, limit = 3): { top: ShownCand[]; more: ShownCand[] } {
    const score = new Map((cell.libTop ?? []).map(x => [x.c, x.s]));
    const all: ShownCand[] = [];
    const add = (c: string, src?: string[]) => {
        if (!all.some(x => x.c === c)) all.push({ c, ...(src ? { src } : {}), ...(score.has(c) ? { score: score.get(c) } : {}) });
    };
    for (const cd of cell.cand ?? []) add(cd.c, cd.src);
    for (const x of (cell.libTop ?? []).slice(0, 3)) add(x.c);
    return { top: all.slice(0, limit), more: all.slice(limit) };
}

/** 预勾：`stale` 有就预勾它的字（`c`）；`occ` 有就预选「非字」。都只是预选，仍须人确认才提交 */
export function preselect(cell: PendingCell): { choice: ReviewChoice; char?: string } | null {
    if (cell.stale?.c) return { choice: 'char', char: cell.stale.c };
    if (cell.occ) return { choice: 'none' };
    return null;
}

/** 雪碧图地址：与 pending_file 同目录。默认正式前缀；联调其他前缀用环境变量改（产物里不得写死 staging 前缀，构建闸会拒） */
export const PROOF_SPRITE_BASE = process.env.NEXT_PUBLIC_PROOF_SPRITE_BASE || 'https://data.kaiyuanguji.com/proof';
export function spriteUrl(book: string, pendingFile: string | null, s: string, base = PROOF_SPRITE_BASE): string | null {
    const dir = pendingFile ? pendingFile.replace(/\.pending\.json$/, '').replace(/\.[^.]+$/, '') : '';
    return dir && /^[\w.-]+$/.test(dir) && /^[\w-]+$/.test(book) && SPRITE_FILE.test(s) ? `${base}/${book}/${dir}/${s}` : null;
}

const RE_REV = /^[A-Za-z0-9._-]{1,64}$/;

const isBox = (v: unknown): v is Box =>
    Array.isArray(v) && v.length === 4 && v.every(n => typeof n === 'number' && Number.isFinite(n)) && v[2] > 0 && v[3] > 0;

const asObject = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** pending.json → 待审格列表（已校过的 `human` 不要）。坏数据不抛 */
export function parsePending(raw: unknown): PendingData {
    const o = asObject(raw);
    const rev = typeof o?.rev === 'string' && RE_REV.test(o.rev) ? o.rev : null;
    const rawList = Array.isArray(raw) ? raw : o?.cells;
    // 规范（book-text#148）格号键叫 `cell`；mock 与旧样张叫 `a`，两种都收
    const list = (Array.isArray(rawList) ? rawList : []).map(item => {
        const it = asObject(item);
        return it && typeof it.a !== 'string' && typeof it.cell === 'string' ? { ...it, a: it.cell } : item;
    });
    const boxes = new Map<string, Box>();
    const extras = new Map<string, unknown>();
    for (const item of list) {
        const it = asObject(item);
        if (it && typeof it.a === 'string' && isBox(it.box)) boxes.set(it.a, it.box);
        if (it && typeof it.a === 'string') extras.set(it.a, it);
    }
    const cells: PendingCell[] = [];
    for (const cell of parseProof(list).cells.values()) {
        if (cell.review === 'human') continue;
        const box = boxes.get(cell.a);
        cells.push({ a: cell.a, ...(cell.c ? { c: cell.c } : {}), ...(cell.cand ? { cand: cell.cand } : {}), ...(box ? { box } : {}), ...parseExtras(extras.get(cell.a)) });
    }
    return { rev, cells };
}

export interface CordIndex {
    boxes: Map<string, Box>;
    /** 页序 → IIIF 页序与 canvas 宽高（坐标系的宽高，用来换算原图缩放、在整页上画框） */
    pages: Map<number, { seq: string; width: number; height: number }>;
    /** IIIF 册目录（canvas id `…/iiif/<书>/canvas/<册>/<页序>` 里的册，如 '01'）；URL 上的 vol01 不是它，取不到就是 null */
    iiifVol: string | null;
}

/** cord.json（guji-cord）→ 格位到框、页到 IIIF 页序。坏数据不抛 */
export function parseCord(raw: unknown): CordIndex {
    const out: CordIndex = { boxes: new Map(), pages: new Map(), iiifVol: null };
    const pages = asObject(raw)?.pages;
    for (const p of Array.isArray(pages) ? pages : []) {
        const po = asObject(p);
        if (!po) continue;
        const page = Number(po.page);
        const canvas = asObject(po.canvas);
        const seq = canvas?.seq;
        if (out.iiifVol === null && typeof canvas?.id === 'string') {
            out.iiifVol = /\/iiif\/[^/]+\/canvas\/([^/]+)\/[^/]+$/.exec(canvas.id)?.[1] ?? null;
        }
        if (Number.isInteger(page) && (typeof seq === 'string' || typeof seq === 'number') && String(seq) !== '') {
            const width = Number(canvas?.width ?? asObject(po.image)?.width);
            const height = Number(canvas?.height ?? asObject(po.image)?.height);
            const pos = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);
            out.pages.set(page, { seq: String(seq), width: pos(width), height: pos(height) });
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
    /** canvas 高；0＝不知道（整页画框时按图的宽高比推） */
    canvasHeight?: number;
}

/** 这一格能不能裁图：pending 的 box 优先，其次 cord；页序只能来自 cord，缺了就不裁 */
export function resolveCrop(cell: PendingCell, cord: CordIndex | null): CellCrop | null {
    if (!cord) return null;
    const box = cell.box ?? cord.boxes.get(cell.a);
    const page = cord.pages.get(Number(cell.a.split(':')[0]));
    if (!box || !page) return null;
    return { box, seq: page.seq, canvasWidth: page.width, canvasHeight: page.height };
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

/** 章条目是否开着精校：只认 `chapters[].proofing === true`（book-text#148，不从版本号推）。阅读页横幅也走这里 */
export const isProofingChapter = (ch: unknown): boolean => asRecord(ch)?.proofing === true;

/** 章：`proofing: true` 且声明了 `pending_file` 的里，按 vol／key／id／文件名主干对上 `vol`；只有一个时就是它 */
export function pickProofingChapter(index: unknown, vol: string): Record<string, unknown> | null {
    const chapters = asRecord(index)?.chapters;
    const cands = (Array.isArray(chapters) ? chapters : [])
        .map(asRecord)
        .filter((c): c is Record<string, unknown> => !!c && isProofingChapter(c) && typeof c.pending_file === 'string');
    const stem = (v: unknown) => (typeof v === 'string' ? v.replace(/\.[^.]+$/, '') : '');
    const hit = cands.find(c => c.vol === vol || c.key === vol || c.id === vol || stem(c.file) === vol || stem(c.pending_file) === vol);
    return hit ?? (cands.length === 1 ? cands[0] : null);
}

/** 版本顺序：original 在前，其余照 manifest 的顺序 */
export function versionKeys(manifest: unknown): string[] {
    const versions = asRecord(manifest)?.versions;
    const keys = (Array.isArray(versions) ? versions : []).map(asRecord).flatMap(v => (v && typeof v.key === 'string' ? [v.key] : []));
    return [...keys.filter(k => k === 'original'), ...keys.filter(k => k !== 'original')];
}

/** 字 id（页:列:格）→ 机器读字，取自 char_file（经 adaptCharCord）。坏数据返回空表，不抛 */
export function charMapOf(charRaw: unknown, cordRaw: unknown): Map<string, string> {
    const out = new Map<string, string>();
    try {
        for (const pg of adaptCharCord(charRaw, cordRaw)) {
            for (const col of pg.columns) for (const ch of col.chars) if (ch.id && ch.char) out.set(ch.id, ch.char);
        }
    } catch { /* 当没有 */ }
    return out;
}

// ---- 上下文 ----

/** char_file 里没定字的格写的占位符 */
export const LACUNA = '□';

/** 一个字位：格号与这一格现在的字（char_file 里的字；待审格就是机器读的字） */
export interface ReadSlot { a: string; c: string }

/** 格号「页:列:格[a|b]」→ [页, 列]；不合式返回 null */
export function pageColOf(a: string): [number, number] | null {
    const m = /^(\d+):(\d+):\d+[a-z]?$/.exec(a);
    return m ? [Number(m[1]), Number(m[2])] : null;
}

/** char_file → 全册阅读顺序（页升序、列升序即从右到左、列内照文件顺序）。坏数据返回空表，不抛 */
export function readingOrder(charRaw: unknown): ReadSlot[] {
    const out: ReadSlot[] = [];
    const pages = asObject(charRaw)?.pages;
    const list = (Array.isArray(pages) ? pages : []).map(asObject).filter((p): p is Record<string, unknown> => !!p);
    const sorted = [...list].sort((x, y) => (Number(x.page) || 0) - (Number(y.page) || 0));
    for (const p of sorted) {
        const cols = (Array.isArray(p.columns) ? p.columns : []).map(asObject).filter((c): c is Record<string, unknown> => !!c);
        for (const col of [...cols].sort((x, y) => (Number(x.col) || 0) - (Number(y.col) || 0))) {
            for (const cell of Array.isArray(col.cells) ? col.cells : []) {
                const co = asObject(cell);
                if (co && typeof co.a === 'string' && pageColOf(co.a)) out.push({ a: co.a, c: typeof co.c === 'string' ? co.c : '' });
            }
        }
    }
    return out;
}

export interface CellContext {
    before: ReadSlot[];
    after: ReadSlot[];
}

/** 本位前后各 n 个字，跨列、跨页补够（同控制台审阅卡的口径）。本位不在阅读顺序里返回 null */
export function contextAround(order: ReadSlot[], pos: Map<string, number>, a: string, n = 10): CellContext | null {
    const i = pos.get(a);
    if (i === undefined) return null;
    return { before: order.slice(Math.max(0, i - n), i), after: order.slice(i + 1, i + 1 + n) };
}

export function positionIndex(order: ReadSlot[]): Map<string, number> {
    return new Map(order.map((s, i) => [s.a, i]));
}

export interface ProofingDeps {
    getManifest: (id: string) => Promise<unknown>;
    getIndex: (id: string, key: string) => Promise<unknown>;
    getFile: (id: string, key: string, file: string) => Promise<unknown>;
}

export type ProofingLoad =
    | { status: 'ok'; pending: PendingData; cord: CordIndex | null; versionKey: string; pendingFile: string; order: ReadSlot[] }
    | { status: 'none' | 'error' };

const SAFE_FILE = /^[\w.-]+$/;

/** 取待审单与（若有）cord、char。没有该册、没声明、取不到都不抛，回 status */
export async function loadProofing(deps: ProofingDeps, book: string, vol: string): Promise<ProofingLoad> {
    try {
        const manifest = await deps.getManifest(book);
        for (const versionKey of versionKeys(manifest)) {
            // 某一版本的目录取不到不挡其他版本
            const index = await deps.getIndex(book, versionKey).catch(() => null);
            const chapter = pickProofingChapter(index, vol);
            const pendingFile = chapter?.pending_file;
            if (!chapter || typeof pendingFile !== 'string' || !SAFE_FILE.test(pendingFile)) continue;
            const named = (k: string) => (typeof chapter[k] === 'string' && SAFE_FILE.test(chapter[k] as string) ? (chapter[k] as string) : null);
            const cordFile = named('cord_file');
            const charFile = named('char_file');
            const [pendingRaw, cordRaw, charRaw] = await Promise.all([
                deps.getFile(book, versionKey, pendingFile),
                cordFile ? deps.getFile(book, versionKey, cordFile).catch(() => null) : null,
                charFile ? deps.getFile(book, versionKey, charFile).catch(() => null) : null,
            ]);
            if (!pendingRaw) return { status: 'error' };
            const pending = parsePending(pendingRaw);
            // 规范的 pending 先不带 c／cand：机器读字从 char_file 补
            if (charRaw && pending.cells.some(c => !c.c)) {
                const chars = charMapOf(charRaw, null);
                // 缺字占位「□」（lacuna）不算机器读到的字
                pending.cells = pending.cells.map(c => (c.c || !chars.get(c.a) || chars.get(c.a) === LACUNA ? c : { ...c, c: chars.get(c.a) }));
            }
            return { status: 'ok', pending, cord: cordRaw ? parseCord(cordRaw) : null, versionKey, pendingFile, order: charRaw ? readingOrder(charRaw) : [] };
        }
        return { status: 'none' };
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
