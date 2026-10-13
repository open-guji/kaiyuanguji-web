/**
 * 校对层数据（overview#605 D 块 D1.1）：CV 导出的 `proof.json`（`guji-proof/0.1`）→ 阅读器按格位 key 取用的只读视图。
 *
 * 约定（Mila 在 #605 对表，Ella 写入 D 块设计 §二）：
 *   - 格位坐标用 `a`＝`页:列:格[a|b]`，与阅读器字 id（`cell.a`）同一坐标；**不用 `id`**（字框稳定 id，与坐标无关）；
 *   - `review` 现为 `pending|auto|human` 三值，未知值一律按 `pending`（偏安全，不把没人看过的当成已校）；
 *   - `method` 是开集（`human`、`cv:<通道>`、`cv:occluded_default`…），原样保留，**不做枚举分支**；
 *   - `a=-1`（版框外的槽）与形态不对的 `a` 忽略；
 *   - 没有服务端切片，按页取用 `a.split(':')[0]`。
 * 本模块只读、不抛：缺失、坏 JSON、字段未知都返回空层，阅读页照常。
 */

export type ProofReview = 'pending' | 'auto' | 'human';

export interface ProofCell {
    /** 格位坐标 `页:列:格[a|b]` */
    a: string;
    /** 识别出的字；被遮挡缺字时是 `□` */
    c?: string;
    /** 识别方式，开集，原样显示 */
    method: string;
    review: ProofReview;
    /** 候选字 */
    cand?: string[];
    channel?: string;
}

export interface ProofLayer {
    /** 格位坐标 → 校对信息 */
    cells: Map<string, ProofCell>;
    /** 页序 → 该页的格位坐标，供按页取用 */
    pages: Map<number, string[]>;
}

const CELL_KEY = /^\d+:\d+:\d+[ab]?$/;

const REVIEWS: readonly string[] = ['pending', 'auto', 'human'];

export function emptyProofLayer(): ProofLayer {
    return { cells: new Map(), pages: new Map() };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

/** 把未知输入规整成 ProofLayer；整体形状不对返回空层，单条不合格的跳过。同一 `a` 重复时后者覆盖前者 */
export function parseProof(raw: unknown): ProofLayer {
    const layer = emptyProofLayer();
    const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? (raw as { cells?: unknown }).cells : null;
    if (!Array.isArray(list)) return layer;
    for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const o = item as Record<string, unknown>;
        const a = str(o.a);
        if (!a || !CELL_KEY.test(a)) continue;
        const review = typeof o.review === 'string' && REVIEWS.includes(o.review) ? (o.review as ProofReview) : 'pending';
        const cand = Array.isArray(o.cand) ? o.cand.filter((x): x is string => typeof x === 'string' && x !== '') : undefined;
        const cell: ProofCell = { a, method: str(o.method) ?? '', review };
        const c = str(o.c);
        if (c) cell.c = c;
        if (cand && cand.length) cell.cand = cand;
        const channel = str(o.channel);
        if (channel) cell.channel = channel;
        if (!layer.cells.has(a)) {
            const page = Number(a.split(':')[0]);
            const keys = layer.pages.get(page);
            if (keys) keys.push(a);
            else layer.pages.set(page, [a]);
        }
        layer.cells.set(a, cell);
    }
    return layer;
}

/** 取某一页的校对格（页序＝`page.index`）；没有该页返回空数组 */
export function proofPage(layer: ProofLayer, page: number): ProofCell[] {
    const out: ProofCell[] = [];
    for (const a of layer.pages.get(page) ?? []) {
        const cell = layer.cells.get(a);
        if (cell) out.push(cell);
    }
    return out;
}

/** 是否「存疑」：没有人看过且不是缺字——公开页默认只展示这一类（Morgan，#605） */
export const isDoubtful = (cell: ProofCell): boolean => cell.review === 'pending' && cell.c !== '□';

/** 被遮挡缺字，单独标为「缺字」，不算识别存疑 */
export const isMissingChar = (cell: ProofCell): boolean => cell.c === '□';

/** 只有 `human` 才可以写「人工校过」；`auto` 与 `pending` 都是机器认定、未经人看 */
export const isHumanChecked = (cell: ProofCell): boolean => cell.review === 'human';

const cache = new Map<string, Promise<ProofLayer>>();

/**
 * 取本章的校对层。章在 `index.json` 里用 `proof_file` 声明（与 `char_file` 等同一套约定，只认章目录下的文件名）；
 * 未声明、取不到、解析失败都返回空层且不缓存失败。`getTextFile` 与 duidu-data 同源（transport 上有就用，否则读同域 /data）。
 */
export function loadProofLayer(
    id: string,
    ctx: { versionKey: string | null; chapter: Record<string, unknown> | null } | undefined,
    storage?: { getTextFile?: (id: string, key: string, file: string) => Promise<unknown> },
): Promise<ProofLayer> {
    const key = ctx?.versionKey;
    const file = ctx?.chapter?.proof_file;
    if (!key || typeof file !== 'string' || !/^[\w.-]+$/.test(file)) return Promise.resolve(emptyProofLayer());
    const cacheKey = `${id}/${key}/${file}`;
    let p = cache.get(cacheKey);
    if (!p) {
        p = (async () => {
            try {
                const raw =
                    typeof storage?.getTextFile === 'function'
                        ? await storage.getTextFile.call(storage, id, key, file)
                        : await fetch(`/data/items/${id}/${key}/${file}`).then(r => (r.ok ? r.json() : null));
                return parseProof(raw);
            } catch {
                return emptyProofLayer();
            }
        })();
        cache.set(cacheKey, p);
        p.then(l => {
            if (l.cells.size === 0) cache.delete(cacheKey);
        });
    }
    return p;
}
