/**
 * 对校：本册（底本字格序列）与对照本（维基文庫，按卷）现场比对，结果只在内存，不入库。
 * 本文件无 React、无网络依赖（取对照本的方法由调用方传入），便于单测。
 */
import { classify, type DiffCat, type VariantTest } from './classify';
import { diffChars } from './diff';
import { splitVolumes, wikiFileOf, type BaseCell, type Heading, type VolumeSeg, type WikiChapter } from './volumes';
import { chapterChars, wikiChars } from './wikitext';

export interface CompareItem {
    id: string;
    cat: DiffCat;
    /** sub 替换 / ins 对照本多出 / del 底本有而对照本没有 */
    type: 'sub' | 'ins' | 'del';
    /** 本册字格序列里的 [i1,i2)；ins 时 i1===i2，插入点在第 i1-1 个字之后 */
    i1: number;
    i2: number;
    /** 底本格位：ins 取插入点前一字 */
    anchor: { start: string; end: string };
    /** 底本的字（ins 为空） */
    base: string;
    /** 对照本的字（del 为空） */
    reading: string;
    /** 上下文各 CTX 字：底本、对照本 */
    ctx: { base: [string, string]; reading: [string, string] };
    /** 所在卷序号 */
    volNo: number | null;
}

export type SegStatus = 'ok' | 'no-wiki' | 'fetch-failed' | 'too-different';

export interface SegResult {
    no: number | null;
    label: string;
    from: number;
    to: number;
    status: SegStatus;
    /** 对照本章文件 */
    wikiFile: string | null;
    /** 相似度 0..1（ok 时有） */
    similarity?: number;
}

export interface CompareResult {
    items: CompareItem[];
    segments: SegResult[];
}

const CTX = 6;
const K = 10;

/**
 * 本册只含某卷的一部分时，把对照本那卷裁到对应的一段：
 * 用底本头（尾）若干字的 K 字片段在对照本里找位置（取第一个找到的探针，退而求其次往后移），裁到那里。
 */
export function trimWikiToBase(base: readonly string[], wiki: readonly string[], start: boolean, end: boolean): [number, number] {
    let j0 = 0;
    let j1 = wiki.length;
    if (!start && !end) return [j0, j1];
    const grams = new Map<string, number[]>();
    for (let p = 0; p + K <= wiki.length; p++) {
        const g = wiki.slice(p, p + K).join('');
        const list = grams.get(g);
        if (list) list.push(p);
        else grams.set(g, [p]);
    }
    const probes = 40;
    const step = 5;
    if (start) {
        for (let n = 0; n < probes; n++) {
            const o = n * step;
            if (o + K > base.length) break;
            const hit = grams.get(base.slice(o, o + K).join(''));
            if (hit && hit.length >= 1) {
                j0 = Math.max(0, hit[0] - o);
                break;
            }
        }
    }
    if (end) {
        for (let n = 0; n < probes; n++) {
            const o = n * step;
            if (base.length - o - K < 0) break;
            const hit = grams.get(base.slice(base.length - o - K, base.length - o).join(''));
            if (hit && hit.length >= 1) {
                j1 = Math.min(wiki.length, hit[hit.length - 1] + K + o);
                break;
            }
        }
    }
    return j0 < j1 ? [j0, j1] : [0, wiki.length];
}

export interface CompareInput {
    cells: readonly BaseCell[];
    headings: readonly Heading[];
    /** 上一册末尾所在的卷（无则 null）与下一册是否接着本册最后一卷 */
    prevVolNo: number | null;
    lastContinues: boolean;
    wikiChapters: readonly WikiChapter[];
    /** 取对照本某章的 md 文本；取不到返回 null */
    getWikiMd: (file: string) => Promise<string | null>;
    isVariant: VariantTest;
}

async function compareSeg(input: CompareInput, seg: VolumeSeg, out: CompareItem[], idStart: number, whole?: { md: string; file: string }): Promise<SegResult> {
    const res: SegResult = { no: seg.no, label: seg.label, from: seg.from, to: seg.to, status: 'ok', wikiFile: null };
    const file = whole ? whole.file : seg.no === null ? null : wikiFileOf(seg.no, input.wikiChapters);
    if (!file) return { ...res, status: 'no-wiki' };
    res.wikiFile = file;
    const md = whole ? whole.md : await input.getWikiMd(file);
    if (md === null) return { ...res, status: 'fetch-failed' };
    const base = input.cells.slice(seg.from, seg.to).map((c) => c.c);
    let wiki = whole ? chapterChars(md) : wikiChars(md);
    if (!whole) {
        const [j0, j1] = trimWikiToBase(base, wiki, seg.startsPartial, seg.endsPartial);
        wiki = wiki.slice(j0, j1);
    }
    const hunks = diffChars(base, wiki);
    if (!hunks) return { ...res, status: 'too-different' };
    const structEnd = seg.headEnd - seg.from;
    let changed = 0;
    hunks.forEach((h, n) => {
        const cat = classify(h, base, wiki, { isVariant: input.isVariant, structEnd });
        const ins = h.i1 === h.i2;
        const del = h.j1 === h.j2;
        changed += Math.max(h.i2 - h.i1, h.j2 - h.j1);
        const gi1 = seg.from + h.i1;
        const gi2 = seg.from + h.i2;
        const anchorAt = (i: number) => input.cells[Math.min(Math.max(i, 0), input.cells.length - 1)].a;
        out.push({
            id: `v${String(idStart + n + 1).padStart(4, '0')}`,
            cat,
            type: ins ? 'ins' : del ? 'del' : 'sub',
            i1: gi1,
            i2: gi2,
            anchor: { start: anchorAt(ins ? gi1 - 1 : gi1), end: anchorAt(ins ? gi1 - 1 : gi2 - 1) },
            base: base.slice(h.i1, h.i2).join(''),
            reading: wiki.slice(h.j1, h.j2).join(''),
            ctx: {
                base: [base.slice(Math.max(0, h.i1 - CTX), h.i1).join(''), base.slice(h.i2, h.i2 + CTX).join('')],
                reading: [wiki.slice(Math.max(0, h.j1 - CTX), h.j1).join(''), wiki.slice(h.j2, h.j2 + CTX).join('')],
            },
            volNo: seg.no,
        });
    });
    const total = base.length + wiki.length;
    res.similarity = total === 0 ? 1 : Math.max(0, 1 - changed / Math.max(base.length, wiki.length, 1));
    return res;
}

/** 比对一册：按卷分段，各卷分别取对照本、分别比对（不跨卷错位），结果按底本字序排列 */
export async function compareChapter(input: CompareInput): Promise<CompareResult> {
    const segs = splitVolumes(input.cells, input.headings, input.prevVolNo, input.lastContinues);
    const items: CompareItem[] = [];
    const segments: SegResult[] = [];
    for (const seg of segs) segments.push(await compareSeg(input, seg, items, items.length));
    items.sort((a, b) => a.i1 - b.i1 || a.i2 - b.i2);
    return { items, segments };
}

/**
 * 同一本书另一个版本（章文件与底本一一对应）的整章比对：不分卷、不裁剪，整章对整章。
 * md 是对照版本里同一个章文件的内容；file 记在结果里（便于提示）。
 */
export async function compareWhole(input: { cells: readonly BaseCell[]; md: string; file: string; label: string; isVariant: VariantTest }): Promise<CompareResult> {
    const seg: VolumeSeg = { no: null, label: input.label, from: 0, to: input.cells.length, startsPartial: false, endsPartial: false, headEnd: 0 };
    const items: CompareItem[] = [];
    const full: CompareInput = { cells: input.cells, headings: [], prevVolNo: null, lastContinues: false, wikiChapters: [], getWikiMd: async () => input.md, isVariant: input.isVariant };
    const res = await compareSeg(full, seg, items, 0, { md: input.md, file: input.file });
    items.sort((a, b) => a.i1 - b.i1 || a.i2 - b.i2);
    return { items, segments: [res] };
}
